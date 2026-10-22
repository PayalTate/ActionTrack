import { IsoDate, formatHuman, fromIso, today } from "./dates.js";
import { Item, isOverdue, ownerMatches } from "./store.js";

/** Exactly the arguments the Gmail connector's create_draft tool takes. */
export interface GmailDraftArgs {
  to: string[];
  subject: string;
  body: string;
}

export interface FollowupDraft {
  owner: string;
  itemIds: number[];
  draft: GmailDraftArgs;
}

export interface FollowupPlan {
  drafts: FollowupDraft[];
  /** Owners with open items who cannot get a draft, and why. */
  skipped: Array<{ owner: string; reason: string; itemIds: number[] }>;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function itemLine(n: number, it: Item, now: IsoDate): string {
  let due = "no due date";
  if (it.dueDate) {
    due = `due ${formatHuman(it.dueDate)}`;
    if (isOverdue(it, now)) {
      const days = Math.round((Date.parse(now) - Date.parse(it.dueDate)) / 86_400_000);
      due += `, ${plural(days, "day")} overdue`;
    }
  }
  let from = `${it.meetingTitle}, ${formatHuman(it.meetingDate)}`;
  const again = (it.mentions ?? []).map((m) => fromIso(m.meetingDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
  if (again.length) from += `; raised again ${again.join(", ")}`;
  return `  ${n}. ${it.task} (${due})\n     From: ${from}`;
}

export function composeBody(ownerName: string, items: Item[], now: IsoDate, signature?: string): string {
  const overdue = items.filter((i) => isOverdue(i, now));
  const open = items.filter((i) => !isOverdue(i, now));
  const first = ownerName.split(/\s+/)[0];
  const parts: string[] = [`Hi ${first},`, "", "Here is a quick follow-up on the action items assigned to you in recent meetings."];
  let n = 1;
  if (overdue.length) {
    parts.push("", `Overdue (${overdue.length}):`);
    for (const it of overdue) parts.push(itemLine(n++, it, now));
  }
  if (open.length) {
    parts.push("", `Open (${open.length}):`);
    for (const it of open) parts.push(itemLine(n++, it, now));
  }
  parts.push(
    "",
    overdue.length
      ? "Could you reply with an update on the overdue items, or a new date if they need more time?"
      : "Just reply if any of these need a different date.",
    "",
    "Thanks,",
  );
  if (signature) parts.push(signature);
  return parts.join("\n");
}

export function composeSubject(items: Item[], now: IsoDate): string {
  const overdue = items.filter((i) => isOverdue(i, now)).length;
  const open = items.length - overdue;
  const bits = [overdue ? `${overdue} overdue` : "", open ? `${open} open` : ""].filter(Boolean);
  return `Follow-up: your action items (${bits.join(", ")})`;
}

/**
 * One draft per owner, covering their open and overdue items.
 * Owners without an email address (or with an ambiguous name) are reported, not guessed.
 */
export function planFollowups(
  items: readonly Item[],
  opts: { owner?: string; signature?: string; now?: IsoDate } = {},
): FollowupPlan {
  const now = opts.now ?? today();
  const pending = items.filter((i) => i.status === "open" && (!opts.owner || ownerMatches(i, opts.owner)));

  const groups = new Map<string, Item[]>();
  for (const it of pending) {
    const k = it.ownerEmail ?? `name:${it.owner.toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }

  const plan: FollowupPlan = { drafts: [], skipped: [] };
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => (a.dueDate ?? "9999") .localeCompare(b.dueDate ?? "9999") || a.id - b.id);
    const owner = sorted[0].owner;
    const ids = sorted.map((i) => i.id);
    if (key.startsWith("name:")) {
      const it = sorted[0];
      const reason =
        it.ownerState === "ambiguous"
          ? `"${owner}" matches ${it.ownerCandidates?.join(" and ")}; check the note`
          : owner === "(unassigned)"
            ? "items have no owner"
            : "no email address; list it on the note's Attendees line";
      plan.skipped.push({ owner, reason, itemIds: ids });
      continue;
    }
    plan.drafts.push({
      owner,
      itemIds: ids,
      draft: { to: [sorted[0].ownerEmail!], subject: composeSubject(sorted, now), body: composeBody(owner, sorted, now, opts.signature) },
    });
  }
  plan.drafts.sort((a, b) => a.owner.localeCompare(b.owner));
  return plan;
}
