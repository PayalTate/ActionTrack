import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IsoDate, today } from "./dates.js";

export type Status = "open" | "done";
export type OwnerState = "resolved" | "ambiguous" | "unknown";

export interface Item {
  id: number;
  key: string; // stable identity of the source line, used to make re-ingest idempotent
  owner: string; // display name ("Priya Sharma"), or the token as written when unresolved
  ownerEmail: string | null;
  ownerState: OwnerState;
  ownerCandidates?: string[]; // when ambiguous
  task: string;
  dueDate: IsoDate | null;
  dueText: string | null;
  sourceFile: string; // absolute path
  sourceLine: number;
  meetingTitle: string;
  meetingDate: IsoDate;
  status: Status;
  createdAt: string;
  doneAt: string | null;
  /** Keys of lines in later notes that repeat this item (carried over or ticked off). */
  aliases?: string[];
  /** Later meetings where this item came up again. */
  mentions?: Mention[];
}

export interface Mention {
  sourceFile: string;
  sourceLine: number;
  meetingTitle: string;
  meetingDate: IsoDate;
}

const STOP = new Set(["the", "a", "an", "to", "for", "of", "on", "in", "with", "and", "our", "their", "from", "at", "by"]);

/** Content words of a task, lightly normalised ("Sends the revised quote" ~ "send revised quote"). */
export function taskWords(task: string): Set<string> {
  return new Set(
    task
      .toLowerCase()
      .replace(/\(with [^)]*\)/g, " ")
      .replace(/['’]s\b/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !STOP.has(w))
      .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );
}

/** Same piece of work, written slightly differently? Deliberately strict: a missed link is safer than a wrong one. */
export function sameTask(a: string, b: string): boolean {
  const x = taskWords(a);
  const y = taskWords(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const union = x.size + y.size - shared;
  if (shared / union >= 0.75) return true;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  return shared === small.size && small.size >= 3 && small.size / large.size >= 0.6;
}

export function ownerId(i: Pick<Item, "ownerEmail" | "owner">): string {
  return (i.ownerEmail ?? i.owner).toLowerCase();
}

interface StoreFile {
  version: 1;
  nextId: number;
  items: Item[];
}

export function defaultStorePath(): string {
  const home = process.env.ACTIONTRACK_HOME ?? path.join(process.cwd(), ".actiontrack");
  return path.join(home, "store.json");
}

export function itemKey(sourceFile: string, rawText: string): string {
  const normalised = rawText.toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("sha1").update(`${path.resolve(sourceFile)}\n${normalised}`).digest("hex").slice(0, 16);
}

export class Store {
  private data: StoreFile;
  constructor(readonly file: string) {
    this.data = Store.read(file);
  }

  private static read(file: string): StoreFile {
    if (!fs.existsSync(file)) return { version: 1, nextId: 1, items: [] };
    let parsed: StoreFile;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`store at ${file} is not valid JSON (${(e as Error).message}); fix or move it aside`);
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) throw new Error(`store at ${file} has an unknown format`);
    return parsed;
  }

  /** Write to a temp file, then rename, so a crash never leaves a half-written store. */
  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    fs.renameSync(tmp, this.file);
  }

  get items(): readonly Item[] {
    return this.data.items;
  }

  findByKey(key: string): Item | undefined {
    return this.data.items.find((i) => i.key === key || i.aliases?.includes(key));
  }

  /**
   * An earlier item, from another note, that this line repeats: same resolved owner, same task.
   * `wantOpen` restricts to open items (a repeat of finished work is new work).
   */
  findEarlier(owner: string, task: string, meetingDate: IsoDate, sourceFile: string, wantOpen: boolean): Item | undefined {
    const matches = this.data.items.filter(
      (i) =>
        i.ownerState === "resolved" &&
        ownerId(i) === owner &&
        i.sourceFile !== sourceFile &&
        i.meetingDate <= meetingDate &&
        (!wantOpen || i.status === "open") &&
        sameTask(i.task, task),
    );
    // Prefer an open item, then the most recently raised one.
    return matches.sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || (b.meetingDate < a.meetingDate ? -1 : 1))[0];
  }

  link(item: Item, key: string, mention: Mention): void {
    item.aliases = [...(item.aliases ?? []), key];
    item.mentions = [...(item.mentions ?? []), mention].sort((a, b) => (a.meetingDate < b.meetingDate ? -1 : 1));
  }

  get(id: number): Item | undefined {
    return this.data.items.find((i) => i.id === id);
  }

  add(item: Omit<Item, "id">): Item {
    const full: Item = { ...item, id: this.data.nextId++ };
    this.data.items.push(full);
    return full;
  }

  markDone(id: number, at = new Date().toISOString()): "done" | "already" | "missing" {
    const it = this.get(id);
    if (!it) return "missing";
    if (it.status === "done") return "already";
    it.status = "done";
    it.doneAt = at;
    return "done";
  }
}

export function isOverdue(item: Item, now: IsoDate = today()): boolean {
  return item.status === "open" && item.dueDate !== null && item.dueDate < now;
}

/** The status users see: open items past their due date show as overdue. */
export function displayStatus(item: Item, now: IsoDate = today()): "open" | "done" | "overdue" {
  return isOverdue(item, now) ? "overdue" : item.status;
}

export interface ListFilter {
  owner?: string;
  status?: "open" | "done" | "overdue";
  dueBefore?: IsoDate;
}

export function ownerMatches(item: Item, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  if (!q) return true;
  const name = item.owner.toLowerCase();
  const email = item.ownerEmail?.toLowerCase() ?? "";
  return name === q || name.split(/\s+/)[0] === q || email === q || email.split("@")[0] === q;
}

export function filterItems(items: readonly Item[], f: ListFilter, now: IsoDate = today()): Item[] {
  return items
    .filter((i) => (f.owner ? ownerMatches(i, f.owner) : true))
    .filter((i) => {
      if (!f.status) return true;
      if (f.status === "overdue") return isOverdue(i, now);
      return i.status === f.status; // "open" includes overdue items
    })
    .filter((i) => (f.dueBefore ? i.dueDate !== null && i.dueDate < f.dueBefore : true))
    .sort((a, b) => {
      // Overdue first, then by due date (no date last), then id.
      const ao = isOverdue(a, now) ? 0 : 1;
      const bo = isOverdue(b, now) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      if (a.dueDate !== b.dueDate) {
        if (a.dueDate === null) return 1;
        if (b.dueDate === null) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      return a.id - b.id;
    });
}
