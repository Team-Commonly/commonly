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
 * Matching: a seat is found by `botMetadata.displayName` (case-insensitive,
 * trimmed) first, then by `username`. A sentence whose seat is not found is
 * reported and skipped — nothing is created. Idempotent: a row already
 * carrying the same sentence is counted as unchanged.
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
  { seat: 'Commonly Support', usernames: ['commonly-support', 'hq-support'], description: 'Answers strangers in HQ. Never quotes, never guesses; escalates with the thread link.' },
  { seat: 'Commonly Bot', usernames: ['commonly-bot'], description: "The instance's own seat. Posts what the system did and where to look." },
  { seat: 'Commonly Summarizer', usernames: ['pod-summarizer', 'commonly-summarizer'], description: 'Digests. Turns a day of a pod into the lines worth reading back.' },
];

const norm = (v: unknown) => String(v || '').trim().toLowerCase();

export type BotRow = { _id: unknown; username?: string; botMetadata?: { displayName?: string; description?: string } };

/** Pure: which sentence applies to which row, and what would change. */
export const planDescriptions = (rows: BotRow[]) => {
  const plan: Array<{ seat: string; userId: unknown; username: string; from: string | undefined; to: string; changed: boolean }> = [];
  const unmatched: string[] = [];
  for (const entry of DESCRIPTIONS) {
    const row = rows.find((r) => norm(r.botMetadata?.displayName) === norm(entry.seat))
      || rows.find((r) => entry.usernames.includes(norm(r.username)));
    if (!row) { unmatched.push(entry.seat); continue; }
    const from = row.botMetadata?.description;
    plan.push({ seat: entry.seat, userId: row._id, username: String(row.username || ''), from, to: entry.description, changed: (from || '').trim() !== entry.description });
  }
  return { plan, unmatched };
};

const APPLY = process.argv.includes('--apply');

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const rows = await User.find({ isBot: true }).select('_id username botMetadata.displayName botMetadata.description').lean() as BotRow[];
    const { plan, unmatched } = planDescriptions(rows);
    let written = 0;
    for (const p of plan) {
      console.log(`${p.changed ? (APPLY ? 'WRITE ' : 'would ') : 'same  '} ${p.seat} (@${p.username}): ${p.changed ? JSON.stringify(p.from || '') + ' → ' : ''}${JSON.stringify(p.to)}`);
      if (APPLY && p.changed) {
        const r = await User.updateOne({ _id: p.userId, isBot: true }, { $set: { 'botMetadata.description': p.to } });
        written += Number(r.modifiedCount || 0);
      }
    }
    console.log(JSON.stringify({ matched: plan.length, changed: plan.filter((p) => p.changed).length, written, unmatched, apply: APPLY }));
    if (!APPLY) console.log('DRY RUN — no User rows changed. Re-run with --apply after review.');
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => { console.error('set-agent-descriptions failed:', error); process.exit(1); });
}
