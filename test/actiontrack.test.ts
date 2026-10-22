import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveDue, parseLooseDate } from "../src/dates.js";
import { planFollowups } from "../src/followup.js";
import { DRAFTS_URL, buildRawMessage, createDraft } from "../src/gmail.js";
import { ingestFolder } from "../src/ingest.js";
import { parseAttendees, resolveOwner } from "../src/owners.js";
import { parseNote, splitOwner } from "../src/parser.js";
import { Store, filterItems, isOverdue } from "../src/store.js";

const MON = "2026-10-19"; // a Monday

describe("due dates resolve against the meeting date", () => {
  it.each([
    ["send the revised quote by Friday", "2026-10-23", "send the revised quote"],
    ["draft the timeline by Oct 30", "2026-10-30", "draft the timeline"],
    ["book the venue by end of week", "2026-10-23", "book the venue"],
    ["review the budget (due: 2026-11-02)", "2026-11-02", "review the budget"],
    ["fix the test by tomorrow", "2026-10-20", "fix the test"],
    ["present on next Monday", "2026-10-26", "present"],
    ["close the books by EOM", "2026-10-31", "close the books"],
  ])("%s", (text, due, task) => {
    const r = resolveDue(text, MON);
    expect(r.dueDate).toBe(due);
    expect(r.task).toBe(task);
  });

  it("returns null when there is no date", () => {
    expect(resolveDue("update the onboarding checklist", MON)).toMatchObject({ dueDate: null, task: "update the onboarding checklist" });
  });

  it("parses loose dates", () => {
    expect(parseLooseDate("19 October 2026")).toBe("2026-10-19");
    expect(parseLooseDate("2026-02-30")).not.toBe("2026-02-30");
  });
});

describe("owners", () => {
  const people = parseAttendees(
    "Priya Sharma <priya.sharma@acme.example>, Rahul Verma <rahul.verma@acme.example>, Rahul Nair <rahul.nair@acme.example>",
  );

  it("parses name <email> entries", () => {
    expect(people[0]).toEqual({ name: "Priya Sharma", email: "priya.sharma@acme.example" });
    expect(parseAttendees(["meera.iyer@acme.example"])[0]).toEqual({ name: "Meera Iyer", email: "meera.iyer@acme.example" });
  });

  it("resolves first name, full name, handle and email", () => {
    for (const t of ["Priya", "Priya Sharma", "@priya.sharma", "priya.sharma@acme.example"]) {
      expect(resolveOwner(t, people)).toMatchObject({ kind: "resolved", attendee: { name: "Priya Sharma" } });
    }
  });

  it("never guesses between two people with the same first name", () => {
    const r = resolveOwner("Rahul", people);
    expect(r.kind).toBe("ambiguous");
    expect(resolveOwner("Rahul Nair", people)).toMatchObject({ kind: "resolved", attendee: { name: "Rahul Nair" } });
  });

  it("splits owner from task in common phrasings", () => {
    expect(splitOwner("Priya to send the quote")).toMatchObject({ ownerToken: "Priya", rest: "send the quote" });
    expect(splitOwner("Priya Sharma will review it")).toMatchObject({ ownerToken: "Priya Sharma", rest: "review it" });
    expect(splitOwner("@meera book the venue")).toMatchObject({ ownerToken: "meera", rest: "book the venue" });
    expect(splitOwner("Meera: circulate the agenda")).toMatchObject({ ownerToken: "Meera", rest: "circulate the agenda" });
    expect(splitOwner("Update the checklist").ownerToken).toBeNull();
  });
});

describe("note parsing", () => {
  it("reads front matter and checkbox lines without a space after ]", () => {
    const note = parseNote(
      ["---", "date: 2026-10-12", "attendees: [Priya <priya@a.example>]", "---", "# Sync", "- [ ]Priya to send the quote by Friday", "- [x] Priya to share the deck"].join("\n"),
      "x.md",
    );
    expect(note).toMatchObject({ title: "Sync", date: "2026-10-12" });
    expect(note.items).toHaveLength(2);
    expect(note.items[0]).toMatchObject({ task: "Send the quote", dueDate: "2026-10-16", checked: false, line: 6 });
    expect(note.items[1].checked).toBe(true);
  });

  it("reads inline Date/Attendees lines and an attendee list", () => {
    const note = parseNote(["# Plan", "**Date:** 19 Oct 2026", "Attendees:", "- Ann <ann@a.example>", "- Bo <bo@a.example>", "", "- [ ] Bo to call"].join("\n"), "p.md");
    expect(note.date).toBe("2026-10-19");
    expect(note.attendees.map((a) => a.name)).toEqual(["Ann", "Bo"]);
    expect(note.items[0].owner).toMatchObject({ kind: "resolved" });
  });

  it("falls back to a date in the file name, and rejects notes with no date", () => {
    expect(parseNote("- [ ] Ann to call", "notes/2026-10-01-call.md").date).toBe("2026-10-01");
    expect(() => parseNote("- [ ] Ann to call", "notes/call.md")).toThrow(/no meeting date/);
  });

  it("ignores invalid YAML front matter with a warning", () => {
    const note = parseNote(["---", "date: [unclosed", "---", "Date: 2026-10-01", "- [ ] x"].join("\n"), "a.md");
    expect(note.date).toBe("2026-10-01");
    expect(note.warnings.join()).toMatch(/invalid YAML/);
  });
});

describe("ingest, list and done", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-"));
    store = new Store(path.join(dir, "store", "store.json"));
    const notes = path.join(dir, "notes");
    fs.mkdirSync(notes);
    fs.writeFileSync(
      path.join(notes, "a.md"),
      ["Date: 2026-10-12", "Attendees: Priya <priya@a.example>, Arjun <arjun@a.example>", "- [ ] Priya to send the quote by Friday", "- [ ] Arjun to plan the rollout by Oct 30"].join("\n"),
    );
    fs.writeFileSync(path.join(notes, "empty.md"), "");
    fs.writeFileSync(path.join(notes, "bin.md"), Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x99]));
    fs.writeFileSync(path.join(notes, "nodate.md"), "- [ ] Arjun to do it");
    fs.writeFileSync(path.join(notes, "ignore.txt"), "Date: 2026-10-12\n- [ ] x");
  });

  it("skips malformed notes, reports them, and keeps the good ones", () => {
    const r = ingestFolder(path.join(dir, "notes"), store);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(3);
    const reasons = r.files.filter((f) => f.status === "skipped").map((f) => f.error);
    expect(reasons).toEqual(expect.arrayContaining(["file is empty", "not valid UTF-8 text", expect.stringMatching(/no meeting date/)]));
    expect(store.items[0]).toMatchObject({ owner: "Priya", ownerEmail: "priya@a.example", dueDate: "2026-10-16", status: "open" });
  });

  it("is idempotent and syncs [x] from the note", () => {
    ingestFolder(path.join(dir, "notes"), store);
    expect(ingestFolder(path.join(dir, "notes"), store).added).toBe(0);
    const file = path.join(dir, "notes", "a.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- [ ] Priya", "- [x] Priya"));
    const r = ingestFolder(path.join(dir, "notes"), store);
    expect(r.completed).toBe(1);
    expect(store.get(1)?.status).toBe("done");
  });

  it("filters by owner, status and due date; overdue is computed", () => {
    ingestFolder(path.join(dir, "notes"), store);
    const now = "2026-10-22";
    expect(filterItems(store.items, { owner: "priya" }, now).map((i) => i.id)).toEqual([1]);
    expect(filterItems(store.items, { status: "overdue" }, now).map((i) => i.id)).toEqual([1]);
    expect(filterItems(store.items, { status: "open" }, now)).toHaveLength(2);
    expect(filterItems(store.items, { dueBefore: "2026-10-30" }, now).map((i) => i.id)).toEqual([1]);
    expect(store.markDone(1)).toBe("done");
    expect(store.markDone(1)).toBe("already");
    expect(store.markDone(42)).toBe("missing");
    expect(isOverdue(store.get(1)!, now)).toBe(false);
    expect(filterItems(store.items, { status: "done" }, now).map((i) => i.id)).toEqual([1]);
  });

  it("persists atomically across instances", () => {
    ingestFolder(path.join(dir, "notes"), store);
    store.save();
    const again = new Store(store.file);
    expect(again.items).toHaveLength(2);
    expect(fs.readdirSync(path.dirname(store.file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("follow-ups", () => {
  const base = {
    key: "k", ownerState: "resolved" as const, dueText: null, sourceFile: "/n.md", sourceLine: 1,
    meetingTitle: "Sync", meetingDate: "2026-10-12", createdAt: "", doneAt: null,
  };
  const items = [
    { ...base, id: 1, owner: "Priya Sharma", ownerEmail: "priya@a.example", task: "Send the quote", dueDate: "2026-10-16", status: "open" as const },
    { ...base, id: 2, owner: "Priya Sharma", ownerEmail: "priya@a.example", task: "Review budget", dueDate: "2026-10-30", status: "open" as const },
    { ...base, id: 3, owner: "Priya Sharma", ownerEmail: "priya@a.example", task: "Old thing", dueDate: "2026-10-01", status: "done" as const },
    { ...base, id: 4, owner: "Rahul", ownerEmail: null, ownerState: "ambiguous" as const, ownerCandidates: ["Rahul V", "Rahul N"], task: "Loop", dueDate: null, status: "open" as const },
  ];

  it("makes one draft per owner covering open and overdue items only", () => {
    const plan = planFollowups(items, { now: "2026-10-22" });
    expect(plan.drafts).toHaveLength(1);
    const d = plan.drafts[0];
    expect(d.itemIds).toEqual([1, 2]);
    expect(d.draft.to).toEqual(["priya@a.example"]);
    expect(d.draft.subject).toBe("Follow-up: your action items (1 overdue, 1 open)");
    expect(d.draft.body).toMatch(/Overdue \(1\):\n  1\. Send the quote \(due .*6 days overdue\)/);
    expect(d.draft.body).not.toMatch(/Old thing/);
  });

  it("reports owners it cannot email instead of guessing", () => {
    const plan = planFollowups(items, { now: "2026-10-22" });
    expect(plan.skipped).toEqual([{ owner: "Rahul", itemIds: [4], reason: expect.stringMatching(/Rahul V and Rahul N/) }]);
  });

  it("filters to one owner", () => {
    expect(planFollowups(items, { owner: "rahul", now: "2026-10-22" }).drafts).toHaveLength(0);
  });
});

describe("gmail mode only ever creates drafts", () => {
  it("posts to drafts.create and nothing else", async () => {
    const calls: Array<{ url: string; method: string; data: any }> = [];
    const fake = { request: async (o: any) => (calls.push(o), { data: { id: "r-123" } }) };
    const r = await createDraft(fake, { to: ["a@b.example"], subject: "Follow-up – é", body: "Hi\nThere" });
    expect(r.id).toBe("r-123");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(calls[0].method).toBe("POST");
    expect(DRAFTS_URL).not.toMatch(/send/);
  });

  it("builds a valid UTF-8 MIME message", () => {
    const raw = Buffer.from(buildRawMessage({ to: ["a@b.example"], subject: "Follow-up – é", body: "Hi\nThere" }), "base64url").toString();
    expect(raw).toMatch(/^To: a@b\.example\r\nSubject: =\?UTF-8\?B\?/);
    const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString()).toBe("Hi\r\nThere");
  });

  it("has no send code anywhere in the source", () => {
    const src = fs.readdirSync("src").map((f) => fs.readFileSync(path.join("src", f), "utf8")).join("\n");
    expect(src).not.toMatch(/messages\/send|drafts\/send|users\.messages\.send/);
  });
});
