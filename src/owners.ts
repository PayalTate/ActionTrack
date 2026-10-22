export interface Attendee {
  name: string;
  email: string | null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function titleCase(s: string): string {
  return s
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Parse one attendee entry. Accepted forms:
 *   Priya Sharma <priya@acme.com>   Priya Sharma (priya@acme.com)   priya@acme.com   Priya Sharma
 */
export function parseAttendee(raw: string): Attendee | null {
  const s = raw.trim().replace(/^[-*+]\s+/, "");
  if (!s) return null;
  const emailMatch = s.match(EMAIL_RE);
  const email = emailMatch ? emailMatch[0].toLowerCase() : null;
  let name = s
    .replace(EMAIL_RE, "")
    .replace(/[<>()[\]"]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!name && email) name = titleCase(email.split("@")[0]);
  if (!name) return null;
  return { name, email };
}

/** Attendees from a front-matter list or a comma/semicolon separated line. */
export function parseAttendees(value: unknown): Attendee[] {
  let parts: string[] = [];
  if (Array.isArray(value)) parts = value.map((v) => String(v));
  else if (typeof value === "string") parts = value.split(/[,;]/);
  else return [];
  const out: Attendee[] = [];
  for (const p of parts) {
    const a = parseAttendee(p);
    if (a) out.push(a);
  }
  return out;
}

export type OwnerResolution =
  | { kind: "resolved"; attendee: Attendee }
  | { kind: "ambiguous"; candidates: Attendee[] }
  | { kind: "unknown" };

const norm = (s: string) => s.trim().toLowerCase();
const firstName = (a: Attendee) => norm(a.name.split(/\s+/)[0]);
const localPart = (a: Attendee) => (a.email ? norm(a.email.split("@")[0]) : "");

/**
 * Match an owner token from an action item ("Priya", "Priya Sharma", "@priya", "priya@acme.com")
 * against the meeting's attendees. Never guesses: two attendees sharing a first name -> ambiguous.
 */
export function resolveOwner(token: string, attendees: Attendee[]): OwnerResolution {
  const t = norm(token.replace(/^@/, ""));
  if (!t) return { kind: "unknown" };

  const pick = (matches: Attendee[]): OwnerResolution | null => {
    if (matches.length === 1) return { kind: "resolved", attendee: matches[0] };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
    return null;
  };

  // "Priya N." / "Priya N" -> first name plus the initial of the last name
  const initial = t.match(/^(\S+)\s+([a-z])\.?$/);
  const lastName = (a: Attendee) => norm(a.name.split(/\s+/).slice(-1)[0]);

  return (
    pick(attendees.filter((a) => a.email !== null && norm(a.email) === t)) ??
    pick(attendees.filter((a) => norm(a.name) === t)) ??
    (initial
      ? pick(attendees.filter((a) => a.name.includes(" ") && firstName(a) === initial[1] && lastName(a).startsWith(initial[2])))
      : null) ??
    pick(attendees.filter((a) => localPart(a) === t)) ??
    pick(attendees.filter((a) => firstName(a) === t)) ?? { kind: "unknown" }
  );
}
