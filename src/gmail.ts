import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { GmailDraftArgs } from "./followup.js";

/**
 * gmail.compose is the narrowest scope that can create drafts. This module only ever calls
 * POST users/me/drafts; DRAFTS_URL is the single endpoint it talks to, and there is no send code.
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
export const DRAFTS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

/** Minimal surface of an authorised client, so tests can supply a fake. */
export interface HttpClient {
  request(opts: { url: string; method: "POST"; data: unknown }): Promise<{ data: any }>;
}

function encodeHeader(value: string): string {
  // RFC 2047 for non-ASCII subjects (names, dashes, etc.)
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildRawMessage(d: GmailDraftArgs): string {
  const headers = [
    `To: ${d.to.join(", ")}`,
    `Subject: ${encodeHeader(d.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(d.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  const mime = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

export async function createDraft(client: HttpClient, d: GmailDraftArgs): Promise<{ id: string }> {
  const url = DRAFTS_URL;
  if (!url.endsWith("/users/me/drafts")) throw new Error("refusing to call anything but drafts.create");
  const res = await client.request({ url, method: "POST", data: { message: { raw: buildRawMessage(d) } } });
  return { id: String(res.data?.id ?? "") };
}

export function configDir(): string {
  return process.env.ACTIONTRACK_CONFIG ?? path.join(os.homedir(), ".actiontrack");
}

interface ClientSecrets {
  client_id: string;
  client_secret: string;
}

function loadSecrets(file: string): ClientSecrets {
  if (!fs.existsSync(file)) {
    throw new Error(
      `Google OAuth client file not found at ${file}.\n` +
        "Create a 'Desktop app' OAuth client in Google Cloud Console (Gmail API enabled), download the JSON, " +
        "and pass it with --credentials or save it at that path.",
    );
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const s = json.installed ?? json.web;
  if (!s?.client_id || !s?.client_secret) throw new Error(`${file} is not a Google OAuth client file`);
  return s;
}

/** Interactive sign-in once; the refresh token is cached (file mode 600) for later runs. */
export async function authorise(credentialsFile: string): Promise<HttpClient> {
  const { OAuth2Client } = await import("google-auth-library");
  const secrets = loadSecrets(credentialsFile);
  const tokenFile = path.join(configDir(), "gmail-token.json");

  if (fs.existsSync(tokenFile)) {
    const client = new OAuth2Client(secrets.client_id, secrets.client_secret);
    client.setCredentials(JSON.parse(fs.readFileSync(tokenFile, "utf8")));
    return client as unknown as HttpClient;
  }

  // Loopback flow: listen on a random local port and catch the redirect.
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = new OAuth2Client(secrets.client_id, secrets.client_secret, redirectUri);
  const authUrl = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [GMAIL_SCOPE] });

  process.stderr.write(`\nOpen this link to let actiontrack create Gmail drafts (it cannot send):\n\n  ${authUrl}\n\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for Google sign-in (5 minutes)")), 300_000);
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.end(c ? "actiontrack is signed in. You can close this tab." : `Sign-in failed: ${err ?? "no code"}`);
      clearTimeout(timer);
      if (c) resolve(c);
      else reject(new Error(`Google sign-in failed: ${err ?? "no code returned"}`));
    });
  }).finally(() => server.close());

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
  return client as unknown as HttpClient;
}
