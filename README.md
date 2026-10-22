# actiontrack

A small CLI that reads markdown meeting notes, tracks their action items, and drafts follow-up emails for you to review. It never sends email.

## Install

Requires Node.js 18 or later.

```bash
npm install          # also compiles TypeScript to dist/
npm link             # optional: puts `actiontrack` on your PATH
npm test             # 68 tests
```

## Note format

Each note needs a meeting date, an attendee list with email addresses, and action items written as checkbox lines. Everything else is free text and is ignored.

```markdown
---
title: Client sync with Northwind
date: 2026-10-12
attendees:
  - Priya Sharma <priya.sharma@acme.example>
  - Arjun Mehta <arjun.mehta@acme.example>
---

Free-form discussion notes...

- [ ] Priya to send the revised quote by Friday
- [ ] @arjun.mehta draft the rollout timeline (due: Oct 20)
- [x] Priya to share the case study deck by Tuesday
```

Front matter is optional. Plain lines such as `Date: 19 October 2026` and `Attendees: Priya <priya@x.com>, Arjun <arjun@x.com>` also work, as does an `Attendees:` line followed by a bulleted list. The meeting date must be a calendar date: vague text like "sometime last week" is rejected and a `YYYY-MM-DD` in the file name is used instead.

Action items can also be written as standalone `ACTION:` / `TODO:` lines, or as a table whose header has an owner column and an action column (and optionally due and status columns). Lines inside code blocks, HTML comments and blockquotes are never treated as actions.

Owners can be written as `Priya to …`, `Priya Sharma will …`, `Priya N. to …`, `Priya: …`, `@handle …` or `name@email …`. `Anita & Rahul to …` creates one item each; `Lena (with Priya) to …` belongs to Lena. Placeholders such as "Everyone", "Someone", "Team" or "TBD" leave the item unassigned.

A date counts as the due date only when written as a deadline: after "by", "due", "before", "on" or "until", or as a bare day such as "tomorrow" or "Friday". It is resolved against the meeting date, so "by Friday" in a Monday 12 Oct meeting becomes 2026-10-16. Supported phrases include weekdays, "next Monday", "Oct 30", ISO dates, "by November" (end of that month), "mid-October" (the 15th), "end of week", "end of next week", "EOD", "EOD tomorrow" and "EOM". Dates that describe the work rather than its deadline ("for November", "from 9 Oct", "last quarter") stay in the task text.

## Commands

```bash
actiontrack ingest <folder> [--recursive] [--quiet]
actiontrack list [--owner <name>] [--status open|done|overdue] [--due-before <date>] [--json]
actiontrack done <id...>
actiontrack followup [owner] [--mode file|gmail] [--dry-run] [--signature <name>]
```

**ingest** parses every `.md` file in the folder and stores each item with its owner, owner email, task, due date, source file and line, and status. Re-running is safe: items already tracked are not duplicated, and a line changed to `- [x]` in the note marks the item done. Notes are merged in meeting-date order, and an item repeated in a later meeting by the same owner is linked to the original instead of duplicated: its due date moves to the latest one given, and a later `- [x]` closes it. Linking is deliberately strict (same resolved owner, nearly the same wording), and items with an ambiguous owner are never linked.

**list** shows items, overdue first. An item is overdue when it is open and its due date is before today; this is computed, never stored. `--status open` includes overdue items. `--due-before` takes ISO dates or phrases like "next friday".

**done** marks one or more items done by id.

**followup** builds one draft per owner covering their open and overdue items. It never sends.

## Getting drafts into Gmail

| Mode | How it works | Setup |
| --- | --- | --- |
| `--mode file` (default) | Writes `.actiontrack/drafts.json`. Each entry's `draft` object has exactly the `to`, `subject`, `body` arguments of the Gmail connector's `create_draft` tool, so Claude can create the drafts for you. | None |
| `--mode gmail` | Calls the Gmail API `drafts.create` directly. | A Google Cloud OAuth client of type **Desktop app** with the Gmail API enabled. Save its JSON as `~/.actiontrack/credentials.json` or pass `--credentials`. First run opens a sign-in link; the token is cached in `~/.actiontrack/gmail-token.json` (mode 600). |

Gmail mode asks only for the `gmail.compose` scope and only ever calls `POST users/me/drafts`. A test checks that no send endpoint exists in the source.

Use `--dry-run` to preview drafts without writing anything.

## Edge cases

| Situation | Behaviour |
| --- | --- |
| Note is empty, binary, not UTF-8, over 1 MB, or has no date | Skipped with the reason; other notes continue; exit code 2 |
| Invalid YAML front matter | Ignored with a warning; inline lines and file name used instead |
| Two attendees share the owner's first name | Owner left unresolved and shown as `Rahul?`; no draft is created for it |
| Item has no owner | Stored as `(unassigned)`; reported by `followup` |
| Owner has no email in the attendee list | Item tracked; `followup` reports it instead of guessing an address |
| Item has no due date | Stored with no date; never overdue |

## Storage and configuration

Items live in `./.actiontrack/store.json`, written atomically. Change the location with `--store <file>` or `ACTIONTRACK_HOME`. `ACTIONTRACK_TODAY=YYYY-MM-DD` overrides today's date for testing and demos.

## Try it

```bash
ACTIONTRACK_TODAY=2026-10-22 actiontrack ingest examples/notes
ACTIONTRACK_TODAY=2026-10-22 actiontrack list --status overdue
ACTIONTRACK_TODAY=2026-10-22 actiontrack followup --dry-run
```

The examples include three deliberately bad notes (empty, binary, no date) and one with two people named Rahul.
