import path from "node:path";
import YAML from "yaml";
import { IsoDate, isIsoDate, parseLooseDate, parseMeetingDate, resolveDue } from "./dates.js";
import { Attendee, OwnerResolution, parseAttendees, resolveOwner } from "./owners.js";

/** A note that cannot be used at all. Ingest skips the file and reports this message. */
export class NoteError extends Error {}

export interface ParsedItem {
  line: number; // 1-based line in the source file
  raw: string; // the item text after the checkbox, as written
  keyText: string; // identity of this item within the file (raw, plus the owner when a line names several)
  checked: boolean; // "- [x]"
  ownerToken: string | null;
  owner: OwnerResolution;
  task: string;
  dueDate: IsoDate | null;
  dueText: string | null;
}

export interface ParsedNote {
  title: string;
  date: IsoDate;
  attendees: Attendee[];
  items: ParsedItem[];
  warnings: string[];
}

const CHECKBOX_RE = /^\s*[-*+]\s*\[([ xX])\]\s*(.*)$/;
const META_RE = /^\s*(?:[-*+]\s+)?\**\s*(date|attendees|participants|title)\s*\**\s*:\s*\**\s*(.*?)\s*$/i;

const NAME = "[A-Z][\\w'.-]*(?:\\s+[A-Z][\\w'.-]*)?";
const VERB = "(?:to|will|should|must|needs? to|has to|have to|is to|are to|is going to)";

/** Words used in the owner slot that are not people. Such items are left unassigned. */
export const PLACEHOLDER_OWNER = /^(?:someone|somebody|anyone|anybody|everyone|everybody|all|team|the team|tbd|tbc|tba|owner|nobody|n\/a|na|\?+)$/i;

export interface OwnerSplit {
  ownerToken: string | null;
  /** More owners named on the same line ("Anita & Rahul to ..."): one item each. */
  coOwners: string[];
  /** Someone helping, not owning ("Lena (with Priya) to ..."). Kept in the task text. */
  helper: string | null;
  /** The word in the owner slot when it is a placeholder ("Everyone"). */
  placeholder: string | null;
  rest: string;
}

/** Pull "Priya" out of "Priya to send the quote", "@priya send...", "Priya: send...". */
export function splitOwner(text: string): OwnerSplit {
  const t = text.trim().replace(/^(?:ACTION|TODO|AI)\s*[:\-]\s*/i, "");
  const out = (ownerToken: string | null, rest: string, extra: Partial<OwnerSplit> = {}): OwnerSplit => {
    if (ownerToken && PLACEHOLDER_OWNER.test(ownerToken.trim())) {
      return { ownerToken: null, coOwners: [], helper: null, placeholder: ownerToken.trim(), rest };
    }
    return { ownerToken, coOwners: [], helper: null, placeholder: null, rest, ...extra };
  };

  const handle = t.match(/^@([\w.-]+)[\s:,-]+(.+)$/);
  if (handle) return out(handle[1], handle[2]);

  const email = t.match(/^([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})[\s:,-]+(?:to\s+|will\s+)?(.+)$/);
  if (email) return out(email[1], email[2]);

  // "Lena (with Priya) to ..." -> Lena owns it, Priya helps
  const helper = t.match(new RegExp(`^(${NAME})\\s*\\((?:with|w/|helped by|\\+)\\s*([^)]+)\\)\\s+${VERB}\\s+(.+)$`));
  if (helper) return out(helper[1], helper[3], { helper: helper[2].trim() });

  // "Anita & Rahul to ...", "Anita and Rahul will ..."
  const joint = t.match(new RegExp(`^(${NAME})\\s*(?:&|\\band\\b|\\+|,)\\s*(${NAME})\\s+${VERB}\\s+(.+)$`));
  if (joint) return out(joint[1], joint[3], { coOwners: [joint[2]] });

  // "Priya to ...", "Priya Sharma will ...", "Priya N. needs to ..."
  const verb = t.match(new RegExp(`^(${NAME})\\s+${VERB}\\s+(.+)$`));
  if (verb) return out(verb[1], verb[2]);

  // "Priya: send ..." / "Priya - send ..."
  const colon = t.match(new RegExp(`^(${NAME})\\s*[:–—]\\s*(.+)$`));
  if (colon) return out(colon[1], colon[2]);

  return out(null, t);
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function splitFrontMatter(content: string): { data: Record<string, unknown>; body: string; bodyOffset: number } {
  if (!/^---\r?\n/.test(content)) return { data: {}, body: content, bodyOffset: 0 };
  const lines = content.split(/\r?\n/);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new NoteError("front matter starts with --- but is never closed");
  let data: unknown;
  try {
    data = YAML.parse(lines.slice(1, end).join("\n"));
  } catch (e) {
    // Bad YAML: ignore it and fall back to the body, but say so.
    return { data: { __invalid: (e as Error).message.split("\n")[0] }, body: lines.slice(end + 1).join("\n"), bodyOffset: end + 1 };
  }
  const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return { data: obj, body: lines.slice(end + 1).join("\n"), bodyOffset: end + 1 };
}

function lowerKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
}

function looksBinary(content: string): boolean {
  if (content.includes("\u0000")) return true;
  const bad = (content.match(/\uFFFD/g) ?? []).length;
  return content.length > 0 && bad / content.length > 0.01;
}

export function parseNote(content: string, filePath: string): ParsedNote {
  const warnings: string[] = [];
  if (looksBinary(content)) throw new NoteError("not a text file");
  if (!content.trim()) throw new NoteError("file is empty");

  const fm = splitFrontMatter(content);
  const meta = lowerKeys(fm.data);
  if (typeof meta.__invalid === "string") warnings.push(`front matter ignored (invalid YAML: ${meta.__invalid})`);

  const bodyLines = fm.body.split(/\r?\n/);
  let title = typeof meta.title === "string" ? meta.title.trim() : "";
  let dateRaw: unknown = meta.date;
  let attendeesRaw: unknown = meta.attendees ?? meta.participants;

  // Inline metadata lines and the first heading.
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const m = line.match(META_RE);
    if (m) {
      const key = m[1].toLowerCase();
      if (key === "date" && dateRaw === undefined) dateRaw = m[2];
      else if ((key === "attendees" || key === "participants") && attendeesRaw === undefined) {
        if (m[2]) attendeesRaw = m[2];
        else {
          // "Attendees:" followed by a bulleted list
          const list: string[] = [];
          while (i + 1 < bodyLines.length && /^\s*[-*+]\s+(?!\[)/.test(bodyLines[i + 1])) list.push(bodyLines[++i]);
          attendeesRaw = list;
        }
      }
      else if (key === "title" && !title) title = m[2];
      continue;
    }
    if (!title) {
      const h = line.match(/^#\s+(.+?)\s*#*\s*$/);
      if (h) title = h[1];
    }
  }
  if (!title) title = path.basename(filePath, path.extname(filePath));

  // Meeting date: metadata (must be a real calendar date), else a date in the file name.
  let date: IsoDate | null = null;
  let vague: string | null = null;
  if (dateRaw instanceof Date) date = parseLooseDate(dateRaw.toISOString().slice(0, 10));
  else if (dateRaw !== undefined && dateRaw !== null && String(dateRaw).trim()) {
    date = parseMeetingDate(String(dateRaw));
    if (!date) vague = String(dateRaw).trim();
  }
  if (!date) {
    const fromName = path.basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
    if (fromName && isIsoDate(fromName[1])) {
      date = fromName[1];
      warnings.push(
        vague
          ? `date "${vague}" is not a calendar date; using ${date} from the file name`
          : `no Date line; using ${date} from the file name`,
      );
    }
  }
  if (!date) {
    throw new NoteError(
      vague
        ? `meeting date "${vague}" is not a calendar date (use e.g. 'Date: 2026-10-03')`
        : "no meeting date (add a 'Date: YYYY-MM-DD' line)",
    );
  }

  const attendees = parseAttendees(attendeesRaw);
  if (attendees.length === 0) warnings.push("no attendees listed; owners cannot be matched to email addresses");

  const items: ParsedItem[] = [];
  const addItem = (lineNo: number, raw: string, checked: boolean) => {
    if (!raw) {
      warnings.push(`line ${lineNo}: empty action item skipped`);
      return;
    }
    const split = splitOwner(raw);
    const due = resolveDue(split.rest, date!);
    let task = capitalise(due.task) || capitalise(split.rest);
    if (split.helper) task += ` (with ${split.helper})`;

    if (split.placeholder) warnings.push(`line ${lineNo}: "${split.placeholder}" is not a person; item left unassigned`);
    else if (!split.ownerToken) warnings.push(`line ${lineNo}: no owner found in "${raw}"`);

    const tokens = split.ownerToken ? [split.ownerToken, ...split.coOwners] : [null];
    for (const token of tokens) {
      const owner: OwnerResolution = token ? resolveOwner(token, attendees) : { kind: "unknown" };
      if (token && owner.kind === "ambiguous")
        warnings.push(`line ${lineNo}: "${token}" matches ${owner.candidates.map((c) => c.name).join(" and ")}; owner left unresolved`);
      else if (token && owner.kind === "unknown" && attendees.length > 0)
        warnings.push(`line ${lineNo}: owner "${token}" is not in the attendee list`);
      items.push({
        line: lineNo,
        raw,
        keyText: tokens.length > 1 ? `${raw} #${token}` : raw,
        checked,
        ownerToken: token,
        owner,
        task,
        dueDate: due.dueDate,
        dueText: due.dueText,
      });
    }
  };

  let fence: string | null = null; // inside ``` or ~~~
  let inComment = false; // inside <!-- ... -->
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const lineNo = fm.bodyOffset + i + 1;

    // Code blocks and HTML comments hold examples and drafts, never agreed actions.
    const f = line.match(/^\s*(```|~~~)/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    // Blockquotes (">") are quoted from someone else, so they never match the patterns below.

    const m = line.match(CHECKBOX_RE);
    if (m) {
      addItem(lineNo, m[2].trim(), m[1].toLowerCase() === "x");
      continue;
    }

    const action = line.match(ACTION_LINE_RE);
    if (action) {
      addItem(lineNo, action[1].trim(), false);
      continue;
    }

    // A table whose header names an owner and an action column holds action items.
    if (/^\s*\|/.test(line) && i + 1 < bodyLines.length && TABLE_SEP_RE.test(bodyLines[i + 1])) {
      const header = tableCells(line).map((c) => c.toLowerCase());
      const col = (re: RegExp) => header.findIndex((h) => re.test(h));
      const ownerCol = col(/\b(owner|who|assignee|responsible)\b/);
      const actionCol = col(/\b(action|task|item|what|todo)\b/);
      const dueCol = col(/\b(due|deadline|when|by)\b/);
      const statusCol = col(/\b(status|done|state)\b/);
      let j = i + 2;
      for (; j < bodyLines.length && /^\s*\|/.test(bodyLines[j]); j++) {
        if (ownerCol < 0 || actionCol < 0) continue;
        const cells = tableCells(bodyLines[j]);
        const who = cells[ownerCol]?.trim() ?? "";
        const what = cells[actionCol]?.trim() ?? "";
        if (!what) continue;
        const when = dueCol >= 0 ? cells[dueCol]?.trim() : "";
        const done = statusCol >= 0 && /^(done|complete[d]?|closed|yes|x|✓|✔)$/i.test(cells[statusCol]?.trim() ?? "");
        const text = `${who ? `${who} to ` : ""}${what.replace(/^./, (c) => c.toLowerCase())}${when ? ` by ${when}` : ""}`;
        addItem(fm.bodyOffset + j + 1, text, done);
      }
      i = j - 1;
    }
  }

  return { title, date, attendees, items, warnings };
}

const ACTION_LINE_RE = /^\s*(?:[-*+]\s+)?\**\s*(?:ACTION|TODO|AI)\s*\**\s*:\s*\**\s*(.+)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function tableCells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
