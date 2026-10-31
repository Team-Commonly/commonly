#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * TASK-718 (TASK-669 slice 3): stamp `createdByUserId` onto legacy task rows.
 *
 * TASK-669 lets a row's creator edit or close a row a peer has claimed. The
 * creator is read from `createdByUserId`, which is stamped once, at create.
 * Rows created before that field existed carry no stamp. Their creator is
 * still on the row, though: API-created rows open with a "Created by …" update
 * whose authorId is the author's user id (the create path pushes it first,
 * `updates: [initUpdate]`), and assignedTaskWakeService already reads
 * updates[0].authorId to answer "who made this row".
 *
 * A row is stamped only when its FIRST update reads "Created by " and carries
 * an authorId. Everything else stays null, which is the non-overridable state:
 * the row keeps today's behaviour and gets no creator override. The text check
 * is load-bearing. A row whose first update is "Claimed by …" carries the
 * claimant's authorId, and trusting it would hand the claimant the override
 * over their own lease.
 *
 * Dry run by default. `--apply` writes. Run it once, offline (backend stopped,
 * so nothing else writes to `tasks` during the run), from backend/:
 *
 *   npm run backfill:task-created-by            # dry run: counts, no writes
 *   npm run backfill:task-created-by -- --apply
 *
 * Re-running is a no-op. The write is compare-and-set on the field being null,
 * so a stamp from an earlier run, or from a create after the deploy, is never
 * overwritten.
 */

import mongoose, { Types } from 'mongoose';
import Task from '../models/Task';

// No index creation on connect. autoIndex would create the declared pair index,
// and migrate-task-source-ref-identity.ts reads that index as proof the new code
// has booted. A backfill run must not manufacture that proof.
mongoose.set('autoIndex', false);

export const CREATED_BY_PREFIX = 'Created by ';

export type LeftNullReason = 'no-created-by-first-update' | 'created-by-without-author';

interface RawTask {
  _id: Types.ObjectId;
  podId: Types.ObjectId;
  taskId: string;
  updates?: Array<{ text?: unknown; authorId?: unknown }> | null;
}

export type CreatorDecision = { creatorId: string } | { reason: LeftNullReason };

// Index 0 only. The create path pushes the "Created by" update first, and
// assignedTaskWakeService trusts updates[0].authorId for the same question. A
// "Created by" update further down is not the creator's, and an authorId on any
// other first update belongs to whoever wrote it, so neither is trusted.
export const decideCreator = (row: Pick<RawTask, 'updates'>): CreatorDecision => {
  const first = row.updates?.[0];
  if (!first || typeof first.text !== 'string' || !first.text.startsWith(CREATED_BY_PREFIX)) {
    return { reason: 'no-created-by-first-update' };
  }
  const creatorId = first.authorId === null || first.authorId === undefined ? '' : String(first.authorId).trim();
  return creatorId ? { creatorId } : { reason: 'created-by-without-author' };
};

export interface StampPlan {
  _id: Types.ObjectId;
  podId: Types.ObjectId;
  taskId: string;
  creatorId: string;
}

export interface LeftNullRow {
  _id: Types.ObjectId;
  podId: Types.ObjectId;
  taskId: string;
  reason: LeftNullReason;
}

export interface BackfillPlan {
  alreadyStamped: number;
  scanned: number;
  toStamp: StampPlan[];
  leftNull: LeftNullRow[];
}

// The raw collection, not the model. This branch's Task schema does not declare
// createdByUserId, and how a model filter on an undeclared path reaches the
// database depends on the strictQuery setting. The collection does what the
// filter says.
export async function planBackfill(): Promise<BackfillPlan> {
  const alreadyStamped = await Task.collection.countDocuments({ createdByUserId: { $ne: null } });
  // $slice keeps the scan to the one update that decides each row.
  const rows = (await Task.collection
    .find({ createdByUserId: null }, { projection: { podId: 1, taskId: 1, updates: { $slice: 1 } } })
    .toArray()) as unknown as RawTask[];
  const plan: BackfillPlan = { alreadyStamped, scanned: rows.length, toStamp: [], leftNull: [] };
  rows.forEach((row) => {
    const decision = decideCreator(row);
    if ('creatorId' in decision) {
      plan.toStamp.push({ _id: row._id, podId: row.podId, taskId: row.taskId, creatorId: decision.creatorId });
    } else {
      plan.leftNull.push({ _id: row._id, podId: row.podId, taskId: row.taskId, reason: decision.reason });
    }
  });
  return plan;
}

// Compare-and-set. The scan and the write are separate reads, so a row can gain
// a stamp between them, and the filter keeps that stamp. The count is what the
// database changed, not what was intended.
export async function writeStamps(stamps: StampPlan[]): Promise<number> {
  if (stamps.length === 0) return 0;
  const result = await Task.collection.bulkWrite(
    stamps.map(({ _id, creatorId }) => ({
      updateOne: {
        filter: { _id, createdByUserId: null },
        update: { $set: { createdByUserId: creatorId } },
      },
    })),
    { ordered: false },
  );
  return result.modifiedCount;
}

export interface BackfillSummary {
  apply: boolean;
  plan: BackfillPlan;
  stamped: number;
}

export async function backfillTaskCreatedBy(options: { apply?: boolean } = {}): Promise<BackfillSummary> {
  const apply = options.apply === true;
  const plan = await planBackfill();
  const stamped = apply ? await writeStamps(plan.toStamp) : 0;
  return { apply, plan, stamped };
}

const LIST_CAP = 20;

// ids only: podId and taskId, never a title, a note or an author.
function printSummary({ apply, plan, stamped }: BackfillSummary): void {
  const count = (reason: LeftNullReason) => plan.leftNull.filter((row) => row.reason === reason).length;
  console.log(apply
    ? '[backfill-task-created-by] APPLIED'
    : '[backfill-task-created-by] DRY RUN — nothing written. Re-run with --apply.');
  console.log(`already stamped (skipped):        ${plan.alreadyStamped}`);
  console.log(`unstamped rows scanned:           ${plan.scanned}`);
  console.log(`creator derivable (to stamp):     ${plan.toStamp.length}`);
  console.log(`left null (not derivable):        ${plan.leftNull.length}`);
  console.log(`  no "Created by" first update:   ${count('no-created-by-first-update')}`);
  console.log(`  "Created by" without an author: ${count('created-by-without-author')}`);
  if (apply) console.log(`stamped:                          ${stamped}`);
  if (plan.leftNull.length > 0) {
    console.log(`left-null rows, podId taskId reason (first ${LIST_CAP}):`);
    plan.leftNull.slice(0, LIST_CAP).forEach((row) => {
      console.log(`  ${row.podId.toString()} ${row.taskId} ${row.reason}`);
    });
    if (plan.leftNull.length > LIST_CAP) console.log(`  … and ${plan.leftNull.length - LIST_CAP} more`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  try {
    printSummary(await backfillTaskCreatedBy({ apply }));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
