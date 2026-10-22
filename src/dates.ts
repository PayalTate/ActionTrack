import * as chrono from "chrono-node";

/** A calendar date as YYYY-MM-DD. All due dates are whole days; no times or time zones. */
export type IsoDate = string;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!ISO_RE.test(s)) return false;
  const d = fromIso(s);
  return toIso(d) === s; // rejects 2026-02-30 and similar
}

/** Local-time Date at noon, so DST shifts can never move it to another day. */
export function fromIso(s: IsoDate): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function toIso(d: Date): IsoDate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(s: IsoDate, n: number): IsoDate {
  const d = fromIso(s);
  d.setDate(d.getDate() + n);
  return toIso(d);
}

/** Today, overridable with ACTIONTRACK_TODAY (used by tests and demos). */
export function today(): IsoDate {
  const forced = process.env.ACTIONTRACK_TODAY;
  if (forced) {
    if (!isIsoDate(forced)) throw new Error(`ACTIONTRACK_TODAY must be YYYY-MM-DD, got "${forced}"`);
    return forced;
  }
  return toIso(new Date());
}

/** "Fri 23 Oct 2026" */
export function formatHuman(s: IsoDate): string {
  return fromIso(s).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Parse a free-text date ("2026-10-20", "20 October 2026", "next Monday") relative to `ref`.
 * Returns null when nothing date-like is found.
 */
export function parseLooseDate(text: string, ref: IsoDate = today()): IsoDate | null {
  const t = text.trim();
  if (isIsoDate(t)) return t;
  const r = chrono.parseDate(t, fromIso(ref), { forwardDate: true });
  return r ? toIso(r) : null;
}

export interface DueResult {
  dueDate: IsoDate | null;
  /** The words that expressed the due date, as written ("by Friday"). */
  dueText: string | null;
  /** The task with the due-date phrase removed. */
  task: string;
}

const RELATIVE_WORDS = /\b(last|next|this|ago|yesterday|today|tomorrow|tonight|sometime|recently|week|weekend)\b/i;

/**
 * A meeting's date must be a real calendar date ("2026-10-03", "9 September 2026",
 * "Monday, 14 September 2026"). Relative or vague text ("sometime last week") returns null,
 * because resolving it against today would silently put the meeting on the wrong day.
 */
export function parseMeetingDate(text: string): IsoDate | null {
  const t = text.trim();
  if (isIsoDate(t)) return t;
  if (!t || RELATIVE_WORDS.test(t)) return null;
  const results = chrono.parse(t, new Date(), { forwardDate: false });
  const r = results.find((x) => x.start.isCertain("day") && x.start.isCertain("month"));
  return r ? toIso(r.start.date()) : null;
}

// Words that introduce a deadline. A date phrase only counts as the due date when one of
// these comes right before it (or it is a bare day word, below). "for November",
// "from 9 Oct", "last quarter" describe the work, not its deadline.
const LEAD_IN = /(?:\b(?:by|before|due(?:\s+(?:on|by))?|on|until|till|no later than|deadline:?)\s+)$/i;
const BARE_DAY = /^(?:today|tonight|tomorrow|(?:(?:this|next)\s+)?(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?)$/i;

function endOfWeek(ref: IsoDate): IsoDate {
  // Friday of the meeting's week; if the meeting is on a weekend, the next Friday.
  const d = fromIso(ref);
  const dow = d.getDay(); // 0 Sun .. 6 Sat
  const delta = dow <= 5 ? 5 - dow : 6;
  return addDays(ref, delta);
}

function endOfMonth(ref: IsoDate, plusMonths = 0): IsoDate {
  const d = fromIso(ref);
  return toIso(new Date(d.getFullYear(), d.getMonth() + 1 + plusMonths, 0, 12));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** The given day of a month on or after the meeting date (next year if already past). */
function dayOfMonthOnOrAfter(ref: IsoDate, monthIndex: number, day: number): IsoDate {
  const r = fromIso(ref);
  let d = new Date(r.getFullYear(), monthIndex, day, 12);
  if (toIso(d) < ref) d = new Date(r.getFullYear() + 1, monthIndex, day, 12);
  return toIso(d);
}

function midMonth(ref: IsoDate, which: string): IsoDate {
  const r = fromIso(ref);
  const w = which.toLowerCase();
  if (w === "month") {
    const thisMonth = toIso(new Date(r.getFullYear(), r.getMonth(), 15, 12));
    return thisMonth >= ref ? thisMonth : toIso(new Date(r.getFullYear(), r.getMonth() + 1, 15, 12));
  }
  if (w === "next month") return toIso(new Date(r.getFullYear(), r.getMonth() + 1, 15, 12));
  return dayOfMonthOnOrAfter(ref, MONTHS.indexOf(w.slice(0, 3)), 15);
}

// Phrases chrono does not handle (or handles wrongly). Order matters: most specific first.
const SPECIAL: Array<{ re: RegExp; resolve: (ref: IsoDate, m: RegExpMatchArray) => IsoDate }> = [
  { re: /\b(?:by\s+)?(?:EOD\s+tomorrow|tomorrow\s+EOD|end of (?:the )?day tomorrow)\b/i, resolve: (ref) => addDays(ref, 1) },
  { re: /\b(?:by\s+)?(?:end of next week|EONW)\b/i, resolve: (ref) => addDays(endOfWeek(ref), 7) },
  { re: /\b(?:by\s+)?(?:EOW|end of (?:the |this )?week)\b/i, resolve: endOfWeek },
  { re: /\b(?:by\s+)?end of next month\b/i, resolve: (ref) => endOfMonth(ref, 1) },
  { re: /\b(?:by\s+)?(?:EOM|end of (?:the |this )?month)\b/i, resolve: (ref) => endOfMonth(ref) },
  {
    re: new RegExp(`\\b(?:by|before|until|due)\\s+mid[-\\s]?(month|next month|${MONTH_RE})\\b`, "i"),
    resolve: (ref, m) => midMonth(ref, m[1]),
  },
  { re: /\b(?:by\s+)?(?:EOD|end of (?:the )?day|today)\b/i, resolve: (ref) => ref },
];

function cleanTask(s: string): string {
  return s
    .replace(/\(\s*(?:due:?)?\s*\)/gi, "") // empty "(due: )" left behind
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;:–—-]+$/u, "")
    .replace(/^[\s,;:–—-]+/u, "")
    .trim();
}

/**
 * Find the due date inside an action item's text, resolved against the meeting date.
 * "Send the revised quote by Friday" (meeting Mon 19 Oct) -> 2026-10-23, task "Send the revised quote".
 * Only deadline phrases count (see LEAD_IN / BARE_DAY); other dates stay in the task text.
 */
export function resolveDue(text: string, meetingDate: IsoDate): DueResult {
  // Explicit "(due: ...)" annotations win.
  const paren = text.match(/\(\s*due:?\s*([^)]+)\)/i);
  if (paren) {
    const dueDate = parseLooseDate(paren[1], meetingDate);
    if (dueDate) {
      return { dueDate, dueText: paren[1].trim(), task: cleanTask(text.replace(paren[0], "")) };
    }
  }

  for (const s of SPECIAL) {
    const m = text.match(s.re);
    if (m && m.index !== undefined) {
      const before = text.slice(0, m.index).replace(LEAD_IN, "");
      return {
        dueDate: s.resolve(meetingDate, m),
        dueText: m[0].trim(),
        task: cleanTask(before + " " + text.slice(m.index + m[0].length)),
      };
    }
  }

  const results = chrono.parse(text, fromIso(meetingDate), { forwardDate: true });
  // Due dates are almost always written last; take the last phrase that is a deadline.
  for (let k = results.length - 1; k >= 0; k--) {
    const r = results[k];
    const before = text.slice(0, r.index);
    const lead = before.match(LEAD_IN);
    // chrono sometimes pulls the lead-in word into its match ("on next Monday")
    const innerLead = /^(?:on|by|before|until|till)\s+/i.test(r.text);
    const bare = BARE_DAY.test(r.text.trim().replace(/^on\s+/i, ""));
    if (!lead && !innerLead && !bare) continue;
    let due: IsoDate;
    if (r.start.isCertain("day") || r.start.isCertain("weekday")) due = toIso(r.start.date());
    else if (r.start.isCertain("month")) {
      // "by November" means by the end of November
      const d = r.start.date();
      due = toIso(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12));
    } else continue; // "by 9" (a time) or similar: not a date
    const start = lead ? r.index - lead[0].length : r.index;
    return {
      dueDate: due,
      dueText: text.slice(start, r.index + r.text.length).trim(),
      task: cleanTask(text.slice(0, start) + " " + text.slice(r.index + r.text.length)),
    };
  }
  return { dueDate: null, dueText: null, task: cleanTask(text) };
}
