#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { formatHuman, parseLooseDate, today } from "./dates.js";
import { planFollowups } from "./followup.js";
import { ingestFolder } from "./ingest.js";
import { Store, defaultStorePath, displayStatus, filterItems } from "./store.js";

const program = new Command();
program
  .name("actiontrack")
  .description("Track action items from markdown meeting notes and draft follow-up emails for review.")
  .version("1.0.0")
  .option("--store <file>", "item store (default: ./.actiontrack/store.json, or $ACTIONTRACK_HOME/store.json)");

const openStore = () => new Store(program.opts().store ? path.resolve(program.opts().store) : defaultStorePath());
const rel = (p: string) => path.relative(process.cwd(), p) || p;

function table(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join("  ")).join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---- ingest ---------------------------------------------------------------
program
  .command("ingest")
  .description("parse every .md meeting note in <folder> and store its action items")
  .argument("<folder>", "folder containing meeting notes")
  .option("-r, --recursive", "include subfolders")
  .option("-q, --quiet", "only print the summary")
  .action((folder: string, opts: { recursive?: boolean; quiet?: boolean }) => {
    const store = openStore();
    const report = ingestFolder(folder, store, { recursive: opts.recursive });
    store.save();

    if (report.files.length === 0) {
      console.log(`No .md files found in ${folder}${opts.recursive ? "" : " (use --recursive for subfolders)"}.`);
      return;
    }
    for (const f of report.files) {
      if (f.status === "skipped") {
        console.log(`SKIPPED  ${rel(f.file)}: ${f.error}`);
        continue;
      }
      if (!opts.quiet) {
        const bits = [`${f.added} new`];
        if (f.carried) bits.push(`${f.carried} carried over from earlier meetings`);
        if (f.completed) bits.push(`${f.completed} marked done`);
        if (f.unchanged) bits.push(`${f.unchanged} already tracked`);
        console.log(`ok       ${rel(f.file)}: ${bits.join(", ")}`);
        for (const w of f.warnings) console.log(`         warning: ${w}`);
      }
    }
    const ok = report.files.length - report.skipped;
    console.log(
      `${opts.quiet ? "" : "\n"}${ok} of ${report.files.length} notes processed; ${report.added} new items` +
        (report.carried ? `, ${report.carried} carried over` : "") +
        (report.completed ? `, ${report.completed} marked done` : "") +
        (report.skipped ? `; ${report.skipped} skipped (see above)` : "") +
        ".",
    );
    if (report.skipped) process.exitCode = 2; // partial success, scriptable
  });

// ---- list -----------------------------------------------------------------
const parseDateArg = (v: string) => {
  const d = parseLooseDate(v);
  if (!d) throw new InvalidArgumentError(`"${v}" is not a date (try 2026-11-01 or "next friday")`);
  return d;
};

program
  .command("list")
  .description("show tracked action items")
  .option("--owner <name>", "owner name, first name, @handle or email")
  .addOption(new Option("--status <status>", "filter by status (open includes overdue)").choices(["open", "done", "overdue"]))
  .option("--due-before <date>", "due strictly before this date", parseDateArg)
  .option("--json", "print JSON instead of a table")
  .action((opts: { owner?: string; status?: "open" | "done" | "overdue"; dueBefore?: string; json?: boolean }) => {
    const store = openStore();
    const now = today();
    const items = filterItems(store.items, { owner: opts.owner, status: opts.status, dueBefore: opts.dueBefore }, now);
    if (opts.json) {
      console.log(JSON.stringify(items.map((i) => ({ ...i, status: displayStatus(i, now) })), null, 2));
      return;
    }
    if (items.length === 0) {
      console.log(store.items.length ? "No items match those filters." : "No items yet. Run: actiontrack ingest <folder>");
      return;
    }
    const rows = [["ID", "STATUS", "OWNER", "DUE", "TASK", "SOURCE"]];
    for (const i of items) {
      const owner = i.ownerState === "ambiguous" ? `${i.owner}?` : i.owner;
      rows.push([
        String(i.id),
        displayStatus(i, now),
        truncate(owner, 18),
        i.dueDate ?? "-",
        truncate(i.task, 48),
        `${rel(i.sourceFile)}:${i.sourceLine}`,
      ]);
    }
    console.log(table(rows));
    const overdue = items.filter((i) => displayStatus(i, now) === "overdue").length;
    console.log(`\n${items.length} item${items.length === 1 ? "" : "s"}${overdue ? `, ${overdue} overdue` : ""} (today: ${formatHuman(now)})`);
    if (items.some((i) => i.ownerState === "ambiguous"))
      console.log("? = name matches more than one attendee; fix the note and re-ingest.");
  });

// ---- done -----------------------------------------------------------------
program
  .command("done")
  .description("mark one or more items as done")
  .argument("<id...>", "item id(s) from `actiontrack list`")
  .action((ids: string[]) => {
    const store = openStore();
    let failed = false;
    for (const raw of ids) {
      const id = Number(raw);
      if (!Number.isInteger(id) || id < 1) {
        console.error(`"${raw}" is not an item id`);
        failed = true;
        continue;
      }
      const r = store.markDone(id);
      const it = store.get(id);
      if (r === "missing") {
        console.error(`No item with id ${id}.`);
        failed = true;
      } else if (r === "already") console.log(`#${id} was already done: ${it!.task}`);
      else console.log(`#${id} done: ${it!.task} (${it!.owner})`);
    }
    store.save();
    if (failed) process.exitCode = 1;
  });

// ---- followup -------------------------------------------------------------
program
  .command("followup")
  .alias("follow-up")
  .description("draft one follow-up email per owner covering open and overdue items (never sends)")
  .argument("[owner]", "only this owner (name, @handle or email)")
  .addOption(
    new Option("--mode <mode>", "file: write drafts for the Gmail connector; gmail: create Gmail drafts via the API")
      .choices(["file", "gmail"])
      .default("file"),
  )
  .option("--out <file>", "where file mode writes drafts (default: next to the store, drafts.json)")
  .option("--credentials <file>", "Google OAuth client JSON for gmail mode (default: ~/.actiontrack/credentials.json)")
  .option("--signature <name>", "name to sign the emails with")
  .option("--dry-run", "print the drafts; write and create nothing")
  .action(
    async (
      owner: string | undefined,
      opts: { mode: "file" | "gmail"; out?: string; credentials?: string; signature?: string; dryRun?: boolean },
    ) => {
      const store = openStore();
      const plan = planFollowups(store.items, { owner, signature: opts.signature });

      for (const s of plan.skipped) console.log(`skipped  ${s.owner} (items ${s.itemIds.join(", ")}): ${s.reason}`);
      if (plan.drafts.length === 0) {
        console.log(owner ? `No open items with an email address for "${owner}".` : "No open items to follow up.");
        return;
      }

      if (opts.dryRun) {
        for (const d of plan.drafts) {
          console.log(`\n--- To: ${d.draft.to.join(", ")}\n--- Subject: ${d.draft.subject}\n\n${d.draft.body}`);
        }
        console.log(`\n${plan.drafts.length} draft(s) previewed; nothing written.`);
        return;
      }

      if (opts.mode === "file") {
        const out = path.resolve(opts.out ?? path.join(path.dirname(openStore().file), "drafts.json"));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const payload = { generatedAt: new Date().toISOString(), note: "Draft only. Review before sending.", drafts: plan.drafts };
        fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
        for (const d of plan.drafts) console.log(`drafted  ${d.owner} <${d.draft.to[0]}>: ${d.draft.subject}`);
        console.log(
          `\n${plan.drafts.length} draft(s) written to ${rel(out)}.\n` +
            "Nothing was sent. Ask Claude to create these as Gmail drafts with the Gmail connector, " +
            "or rerun with --mode gmail.",
        );
        return;
      }

      const { authorise, configDir, createDraft } = await import("./gmail.js");
      const creds = path.resolve(opts.credentials ?? process.env.ACTIONTRACK_GOOGLE_CREDENTIALS ?? path.join(configDir(), "credentials.json"));
      const client = await authorise(creds);
      let made = 0;
      for (const d of plan.drafts) {
        try {
          const r = await createDraft(client, d.draft);
          made++;
          console.log(`drafted  ${d.owner} <${d.draft.to[0]}>: ${d.draft.subject}  (Gmail draft ${r.id})`);
        } catch (e) {
          process.exitCode = 1;
          console.error(`FAILED   ${d.owner}: ${(e as Error).message}`);
        }
      }
      console.log(`\n${made} Gmail draft(s) created. Nothing was sent; review them in Gmail > Drafts.`);
    },
  );

program.parseAsync().catch((e: Error) => {
  console.error(`actiontrack: ${e.message}`);
  process.exit(1);
});

