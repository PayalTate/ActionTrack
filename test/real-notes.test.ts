// Regression tests from a real 36-note folder that exposed parsing and tracking gaps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMeetingDate, resolveDue } from "../src/dates.js";
import { ingestFolder } from "../src/ingest.js";
import { parseAttendees, resolveOwner } from "../src/owners.js";
import { parseNote } from "../src/parser.js";
import { Store } from "../src/store.js";

const people = parseAttendees("Priya Nair, Priya Shah, Rahul Mehta, Rahul Verma, Anita Desai, Lena Fischer");
const note = (lines: string[], name = "2026-09-18-x.md") =>
  parseNote(["Date: 2026-09-18", "Attendees: Priya Nair, Priya Shah, Rahul Mehta, Anita Desai, Lena Fischer", ...lines].join("\n"), name);

describe("owners written with an initial", () => {
  it.each([
    ["Priya N.", "Priya Nair"],
    ["Priya S.", "Priya Shah"],
    ["Priya N", "Priya Nair"],
    ["Rahul V.", "Rahul Verma"],
  ])("%s -> %s", (token, name) => {
    expect(resolveOwner(token, people)).toMatchObject({ kind: "resolved", attendee: { name } });
  });

  it("parses 'Priya N. to ...' as an owner phrase", () => {
    const n = note(["- [ ] Priya N. to send revised quote to Acme — by Friday"]);
    expect(n.items[0]).toMatchObject({ owner: { kind: "resolved", attendee: { name: "Priya Nair" } }, task: "Send revised quote to Acme" });
  });
});

describe("placeholder and joint owners", () => {
  it.each(["Someone", "Everyone", "TBD", "Team", "Owner"])("%s is not a person", (who) => {
    const n = note([`- [ ] ${who} to update the CRM notes`]);
    expect(n.items[0].ownerToken).toBeNull();
    expect(n.items[0].task).toBe("Update the CRM notes");
    expect(n.warnings.join()).toMatch(new RegExp(`"${who}" is not a person`));
  });

  it("splits 'A & B to ...' into one item per person", () => {
    const n = note(["- [ ] Anita & Rahul to agree on the component API by Wednesday"]);
    expect(n.items.map((i) => i.owner.kind === "resolved" && i.owner.attendee.name)).toEqual(["Anita Desai", "Rahul Mehta"]);
    expect(n.items.every((i) => i.task === "Agree on the component API" && i.dueDate === "2026-09-23")).toBe(true);
    expect(new Set(n.items.map((i) => i.keyText)).size).toBe(2);
  });

  it("gives 'A (with B)' to A and keeps the helper in the task", () => {
    const n = note(["- [ ] Lena (with Priya) to collect user feedback on the prototype by 2026-09-25"]);
    expect(n.items).toHaveLength(1);
    expect(n.items[0]).toMatchObject({ owner: { kind: "resolved", attendee: { name: "Lena Fischer" } }, task: "Collect user feedback on the prototype (with Priya)" });
  });
});

describe("lines that look like tasks but are not", () => {
  it("ignores code blocks, HTML comments (one or many lines) and blockquotes", () => {
    const n = note([
      "```", "- [ ] Owner to remediate finding by <date>", "```",
      "~~~", "- [ ] Also not real", "~~~",
      "<!-- - [ ] Sam to buy hardware tokens -->",
      "<!--", "- [ ] Hidden item", "-->",
      "> - [ ] Karan to refund affected customers by Friday",
      "- [ ] Anita to audit contrast",
    ]);
    expect(n.items.map((i) => i.task)).toEqual(["Audit contrast"]);
  });
});

describe("other action formats", () => {
  it("captures standalone ACTION: and TODO: lines", () => {
    const n = note(["ACTION: Lena to circulate the offsite summary tomorrow", "**TODO:** Anita to refresh the brand kit"]);
    expect(n.items.map((i) => [i.task, i.dueDate])).toEqual([["Circulate the offsite summary", "2026-09-19"], ["Refresh the brand kit", null]]);
  });

  it("reads action tables with Owner / Action / Due columns", () => {
    const n = note(["| Owner | Action | Due |", "|-------|--------|-----|", "| Anita | Refresh the brand kit | 2026-10-09 |", "| Lena | Ship the survey | |", "", "Text after."]);
    expect(n.items.map((i) => [i.owner.kind === "resolved" && i.owner.attendee.name, i.task, i.dueDate])).toEqual([
      ["Anita Desai", "Refresh the brand kit", "2026-10-09"],
      ["Lena Fischer", "Ship the survey", null],
    ]);
  });

  it("leaves ordinary tables alone", () => {
    expect(note(["| Metric | Value |", "| --- | --- |", "| Bugs | 37 |"]).items).toHaveLength(0);
  });
});

describe("meeting dates must be calendar dates", () => {
  it.each([
    ["2026-10-03", "2026-10-03"],
    ["9 September 2026", "2026-09-09"],
    ["Monday, 14 September 2026", "2026-09-14"],
    ["sometime last week", null],
    ["yesterday", null],
    ["next Monday", null],
  ])("%s -> %s", (text, iso) => expect(parseMeetingDate(text)).toBe(iso));

  it("falls back to the file name with a warning for a vague date", () => {
    const n = parseNote("# Sales\nDate: sometime last week\n- [ ] Meera to chase Orbit Labs by Friday", "2026-10-03-sales.md");
    expect(n.date).toBe("2026-10-03");
    expect(n.items[0].dueDate).toBe("2026-10-09");
    expect(n.warnings.join()).toMatch(/not a calendar date/);
  });

  it("skips the note when a vague date has no file-name fallback", () => {
    expect(() => parseNote("Date: sometime last week\n- [ ] x", "sales.md")).toThrow(/not a calendar date/);
  });
});

describe("due dates only from deadline phrases", () => {
  const ref = "2026-09-21"; // Monday
  it.each([
    ["write the postmortem by EOD tomorrow", "2026-09-22", "write the postmortem"],
    ["draft the test plan by end of next week", "2026-10-02", "draft the test plan"],
    ["propose the on-call rotation by mid-October", "2026-10-15", "propose the on-call rotation"],
    ["finish the review by mid-month", "2026-10-15", "finish the review"],
    ["ship the deck by November", "2026-11-30", "ship the deck"],
    ["run the survey, results due 15 October", "2026-10-15", "run the survey, results"],
    ["pull the usage report for the last 6 months by tomorrow", "2026-09-22", "pull the usage report for the last 6 months"],
    ["circulate the summary tomorrow", "2026-09-22", "circulate the summary"],
    ["send the deck Friday", "2026-09-25", "send the deck"],
    ["schedule the QBR for November", null, "schedule the QBR for November"],
    ["freeze invoice edits from 9 Oct", null, "freeze invoice edits from 9 Oct"],
    ["schedule cutover for Saturday 10 Oct", null, "schedule cutover for Saturday 10 Oct"],
    ["export last quarter invoices", null, "export last quarter invoices"],
    ["cut cloud costs by 10% — proposal by 2026-10-09", "2026-10-09", "cut cloud costs by 10% — proposal"],
  ])("%s", (text, due, task) => {
    const r = resolveDue(text, ref);
    expect(r.dueDate).toBe(due);
    expect(r.task).toBe(task);
  });
});

describe("items carried across meetings are one item", () => {
  const setup = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-link-"));
    fs.mkdirSync(path.join(dir, "notes"));
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, "notes", n), c);
    return { dir, store: new Store(path.join(dir, "store.json")) };
  };
  const hdr = (date: string, who = "Priya Nair, Rahul Mehta") => `Date: ${date}\nAttendees: ${who}\n`;

  it("links repeats, moves the due date forward, and closes the original when a later note ticks it", async () => {
    const { dir, store } = setup({
      // file names deliberately out of date order: linking follows meeting dates
      "c.md": hdr("2026-09-15") + "- [x] Priya to send the revised quote to Acme\n",
      "a.md": hdr("2026-09-01") + "- [ ] Priya to send the revised quote to Acme by Friday\n- [ ] Rahul to fix the pagination bug\n",
      "b.md": hdr("2026-09-08", "Priya Nair, Priya Shah, Rahul Mehta") + "- [ ] Priya N. to send revised quote to Acme — by Friday\n- [ ] Rahul to fix the pagination bug by Wednesday\n",
    });
    const r = ingestFolder(path.join(dir, "notes"), store);
    expect(store.items).toHaveLength(2);
    const quote = store.items.find((i) => /quote/.test(i.task))!;
    expect(quote).toMatchObject({ status: "done", meetingDate: "2026-09-01", dueDate: "2026-09-11" });
    expect(quote.mentions?.map((m) => m.meetingDate)).toEqual(["2026-09-08", "2026-09-15"]);
    const bug = store.items.find((i) => /pagination/.test(i.task))!;
    expect(bug).toMatchObject({ status: "open", dueDate: "2026-09-09" });
    expect(r.carried).toBe(2);
    const { planFollowups } = await import("../src/followup.js");
    const body = planFollowups(store.items, { now: "2026-09-20" }).drafts;
    expect(body).toHaveLength(0); // no emails in these attendee lines, so nothing to draft
    bug.ownerEmail = "rahul@x.example";
    expect(planFollowups(store.items, { now: "2026-09-20" }).drafts[0].draft.body).toMatch(/From: .*; raised again 8 Sept?/);
    expect(r.completed).toBe(1);
    // re-ingest is still idempotent
    const again = ingestFolder(path.join(dir, "notes"), store);
    expect(again.added + again.carried + again.completed).toBe(0);
    expect(store.items).toHaveLength(2);
  });

  it("does not link different owners or different tasks, and reopens finished work as new", () => {
    const { dir, store } = setup({
      "a.md": hdr("2026-09-01") + "- [ ] Priya to share first wireframes\n- [x] Rahul to deploy the beta\n",
      "b.md": hdr("2026-09-08") + "- [ ] Rahul to share first wireframes\n- [ ] Priya to share updated wireframes\n- [ ] Rahul to deploy the beta\n",
    });
    ingestFolder(path.join(dir, "notes"), store);
    expect(store.items).toHaveLength(5);
  });

  it("never links items whose owner is ambiguous", () => {
    const { dir, store } = setup({
      "a.md": hdr("2026-09-01") + "- [ ] Priya to sign off the checklist\n",
      "b.md": hdr("2026-09-08", "Priya Nair, Priya Shah") + "- [x] Priya to sign off the checklist\n",
    });
    ingestFolder(path.join(dir, "notes"), store);
    expect(store.items.map((i) => i.status)).toEqual(["open", "done"]);
  });
});
