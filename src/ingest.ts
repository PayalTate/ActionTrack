import fs from "node:fs";
import path from "node:path";
import { NoteError, ParsedNote, parseNote } from "./parser.js";
import { Store, itemKey, ownerId } from "./store.js";

export const MAX_FILE_BYTES = 1024 * 1024;

export interface FileReport {
  file: string;
  status: "ok" | "skipped";
  added: number;
  completed: number; // items newly marked done because the note now shows "- [x]"
  carried: number; // lines that repeat an open item from an earlier meeting (linked, not duplicated)
  unchanged: number;
  warnings: string[];
  error?: string;
}

export interface IngestReport {
  files: FileReport[];
  added: number;
  completed: number;
  carried: number;
  unchanged: number;
  skipped: number;
}

export function findNotes(folder: string, recursive: boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(folder);
  return out;
}

function readText(file: string): string {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) throw new NoteError(`file is larger than 1 MB (${Math.round(stat.size / 1024)} KB)`);
  const buf = fs.readFileSync(file);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, "");
  } catch {
    throw new NoteError("not valid UTF-8 text");
  }
}

export function ingestFolder(folder: string, store: Store, opts: { recursive?: boolean } = {}): IngestReport {
  const abs = path.resolve(folder);
  if (!fs.existsSync(abs)) throw new Error(`folder not found: ${folder}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`not a folder: ${folder}`);

  const report: IngestReport = { files: [], added: 0, completed: 0, carried: 0, unchanged: 0, skipped: 0 };
  const now = new Date().toISOString();

  // Pass 1: parse every note on its own. One bad note must never stop the rest.
  const parsed: Array<{ file: string; note: ParsedNote; fr: FileReport }> = [];
  for (const file of findNotes(abs, !!opts.recursive)) {
    const fr: FileReport = { file, status: "ok", added: 0, completed: 0, carried: 0, unchanged: 0, warnings: [] };
    report.files.push(fr);
    try {
      const note = parseNote(readText(file), file);
      fr.warnings.push(...note.warnings);
      parsed.push({ file, note, fr });
    } catch (e) {
      fr.status = "skipped";
      fr.error = e instanceof NoteError ? e.message : `unexpected error: ${(e as Error).message}`;
      report.skipped++;
    }
  }

  // Pass 2: merge in meeting order, so a later note can carry over or close an earlier item.
  parsed.sort((a, b) => (a.note.date === b.note.date ? a.file.localeCompare(b.file) : a.note.date < b.note.date ? -1 : 1));
  for (const { file, note, fr } of parsed) {
    for (const it of note.items) {
      const key = itemKey(file, it.keyText);
      const existing = store.findByKey(key);
      if (existing) {
        if (it.checked && existing.status === "open") {
          store.markDone(existing.id, now);
          fr.completed++;
        } else fr.unchanged++;
        continue;
      }

      const resolved = it.owner.kind === "resolved" ? it.owner.attendee : null;
      const mention = { sourceFile: file, sourceLine: it.line, meetingTitle: note.title, meetingDate: note.date };

      // Only items with a resolved owner are linked: an ambiguous name is never matched to anyone.
      if (resolved) {
        const who = ownerId({ ownerEmail: resolved.email, owner: resolved.name });
        const earlier = store.findEarlier(who, it.task, note.date, file, !it.checked);
        if (earlier) {
          store.link(earlier, key, mention);
          if (it.checked) {
            if (earlier.status === "open") {
              store.markDone(earlier.id, now);
              fr.completed++;
            } else fr.unchanged++;
          } else {
            // Carried over: the latest meeting's due date wins.
            if (it.dueDate) {
              earlier.dueDate = it.dueDate;
              earlier.dueText = it.dueText;
            }
            fr.carried++;
          }
          continue;
        }
      }

      store.add({
        key,
        owner: resolved?.name ?? it.ownerToken ?? "(unassigned)",
        ownerEmail: resolved?.email ?? null,
        ownerState: it.owner.kind,
        ...(it.owner.kind === "ambiguous" ? { ownerCandidates: it.owner.candidates.map((c) => c.name) } : {}),
        task: it.task,
        dueDate: it.dueDate,
        dueText: it.dueText,
        sourceFile: file,
        sourceLine: it.line,
        meetingTitle: note.title,
        meetingDate: note.date,
        status: it.checked ? "done" : "open",
        createdAt: now,
        doneAt: it.checked ? now : null,
      });
      fr.added++;
    }
  }

  for (const fr of report.files) {
    report.added += fr.added;
    report.completed += fr.completed;
    report.carried += fr.carried;
    report.unchanged += fr.unchanged;
  }
  return report;
}
