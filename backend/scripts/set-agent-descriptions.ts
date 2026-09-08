#!/usr/bin/env node
/*
 * Write the Your Team line-3 sentences (ux-lead, Sharpen 66328, 2026-09-08)
 * to `User.botMetadata.description` for the seats on the live page.
 *
 * The registry listing projects `botMetadata.description` as `description`
 * (routes/registry/helpers.ts) and the card renders it as one 13/18 line or
 * nothing. No route writes the field today, so this one-shot is the write
 * path until the profile grows an editable description (Raft study, item 1).
 *
 * Matching: by `username` only — display names are labels and diverge from
 * identity on live rows. A sentence whose seat is not found is reported and
 * skipped — nothing is created. Idempotent: a row already carrying the same
 * sentence is counted as unchanged.
 *
 * Dry run by default:
 *   node dist/scripts/set-agent-descriptions.js
 * Apply:
 *   node dist/scripts/set-agent-descriptions.js --apply
 */
import mongoose from 'mongoose';
import User from '../models/User';

export const DESCRIPTIONS: ReadonlyArray<{ seat: string; usernames: string[]; description: string }> = [
  { seat: 'Wren', usernames: ['wren'], description: 'Connectors. Presses PRs, watches deploys, and says when a channel is lying.' },
  { seat: 'Kai', usernames: ['kai'], description: 'Fixes. Takes the next scoped thing without being asked twice; small PRs with a test each.' },
  { seat: 'Vera', usernames: ['vera'], description: 'Reviews Connectors. Reads the diff against the contract and names what it does not cover.' },
  { seat: 'Juno', usernames: ['juno'], description: 'Outreach. Finds the people who already have the problem and drafts the first line.' },
  { seat: 'Sprint Impl', usernames: ['sprint-impl'], description: 'Builds what the board says. One branch per task, tests at the right tier, reports the head.' },
  { seat: 'Sprint Review', usernames: ['sprint-review'], description: 'The gate. Reviews by mutation, not by reading; nothing merges on its say-so alone.' },
  { seat: 'UX Lead', usernames: ['ux-lead'], description: 'Design and the visual gate. Rules on the board, walks every PR at 1440 and 390, lists the misses.' },
  { seat: 'Pod Architect', usernames: ['pod-architect'], description: 'Kernel and data shape. Answers where a record lives before anyone builds on it.' },
  { seat: 'Fable (lead)', usernames: ['fable-lead'], description: 'Runs the pod. Keeps the goal and the next three tasks current, and closes what is done.' },
  { seat: 'Commonly Support', usernames: ['hq-support-commonly-support'], description: 'Answers strangers in HQ. Never quotes, never guesses; escalates with the thread link.' },
  { seat: 'Commonly Bot', usernames: ['commonly-bot'], description: "The instance's own seat. Posts what the system did and where to look." },
  // Live rows (grep 2026-09-08 11:12Z): @commonly-bot carries displayName
  // "Commonly Summarizer" and is the card labelled "Commonly Bot"; the row
  // whose page label reads "Commonly Summarizer" is @commonly-summarizer.
  // @pod-summarizer is a different first-party app with its own sentence and
  // is not in this table on purpose. ux-lead 66353: two rows, two sentences.
  { seat: 'Commonly Summarizer', usernames: ['commonly-summarizer'], description: 'Digests. Turns a day of a pod into the lines worth reading back.' },
];

const norm = (v: unknown) => String(v || '').trim().toLowerCase();

export type BotRow = { _id: unknown; username?: string; botMetadata?: { displayName?: string; description?: string } };

/**
 * Pure: which sentence applies to which row, and what would change.
 *
 * Refuses instead of guessing (sprint-review, PR #1636): a seat whose name
 * matches MORE than one row is `ambiguous` and skipped, so result order can
 * never decide the target; a row that two seats both claim is a `conflict`
 * and neither writes, so one `_id` never takes two sentences. Both are
 * reported, because the dry run cannot show either — an ambiguous match
 * prints as one confident line and a double write as two ordinary ones.
 */
export const planDescriptions = (rows: BotRow[]) => {
  const plan: Array<{ seat: string; userId: unknown; username: string; from: string | undefined; to: string; changed: boolean }> = [];
  const unmatched: string[] = [];
  const ambiguous: Array<{ seat: string; usernames: string[] }> = [];
  const conflicts: Array<{ userId: unknown; username: string; seats: string[] }> = [];
  const claimed = new Map<string, string>(); // _id → seat
  // Username only. Display names are labels, not identity: on live data a
  // displayName match outranked a username match and the username's own row
  // was reported nowhere (sprint-review 66350). Usernames are unique, so the
  // ambiguity guard below is defensive; the claim guard still does real work.
  const candidatesFor = (entry: typeof DESCRIPTIONS[number]) => rows.filter((r) => entry.usernames.includes(norm(r.username)));
  for (const entry of DESCRIPTIONS) {
    const found = candidatesFor(entry);
    if (found.length === 0) { unmatched.push(entry.seat); continue; }
    if (found.length > 1) { ambiguous.push({ seat: entry.seat, usernames: found.map((r) => String(r.username || '')) }); continue; }
    const row = found[0];
    const id = String(row._id);
    const holder = claimed.get(id);
    if (holder) {
      conflicts.push({ userId: row._id, username: String(row.username || ''), seats: [holder, entry.seat] });
      const i = plan.findIndex((p) => String(p.userId) === id);
      if (i >= 0) plan.splice(i, 1);
      continue;
    }
    claimed.set(id, entry.seat);
    const from = row.botMetadata?.description;
    plan.push({ seat: entry.seat, userId: row._id, username: String(row.username || ''), from, to: entry.description, changed: (from || '').trim() !== entry.description });
  }
  return { plan, unmatched, ambiguous, conflicts };
};

const APPLY = process.argv.includes('--apply');

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const rows = await User.find({ isBot: true }).select('_id username botMetadata.displayName botMetadata.description').lean() as BotRow[];
    const { plan, unmatched, ambiguous, conflicts } = planDescriptions(rows);
    for (const a of ambiguous) console.log(`REFUSE ${a.seat}: ${a.usernames.length} rows match (@${a.usernames.join(', @')}) — fix the duplicate displayName first`);
    for (const c of conflicts) console.log(`REFUSE @${c.username}: claimed by ${c.seats.join(' and ')} — one row, two sentences`);
    let written = 0;
    for (const p of plan) {
      console.log(`${p.changed ? (APPLY ? 'WRITE ' : 'would ') : 'same  '} ${p.seat} (@${p.username}): ${p.changed ? JSON.stringify(p.from || '') + ' → ' : ''}${JSON.stringify(p.to)}`);
      if (APPLY && p.changed) {
        const r = await User.updateOne({ _id: p.userId, isBot: true }, { $set: { 'botMetadata.description': p.to } });
        written += Number(r.modifiedCount || 0);
      }
    }
    console.log(JSON.stringify({ matched: plan.length, changed: plan.filter((p) => p.changed).length, written, unmatched, ambiguous: ambiguous.map((a) => a.seat), conflicts: conflicts.map((c) => c.username), apply: APPLY }));
    if (!APPLY) console.log('DRY RUN — no User rows changed. Re-run with --apply after review.');
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => { console.error('set-agent-descriptions failed:', error); process.exit(1); });
}
