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
 * Run by SRE, on prod, through the throwaway read pod, never the serving
 * backend. The dry run and the apply are separate runs, and the apply takes a
 * frozen id set:
 *
 *   npm run backfill:task-created-by -- --out ids.txt         # dry run: counts, and the ids it would write
 *   npm run backfill:task-created-by -- --apply --ids ids.txt
 *
 * The counts and the id set go to TASK-718 for review before the apply. The
 * apply stamps only the ids in the file, and derives each creator from that row
 * at apply time. It never does a fresh compute, so a row that became derivable
 * after the dry run is not stamped.
 *
 * Re-running is a no-op. The write is compare-and-set on the field being null,
 * so a stamp from an earlier run, or from a create after the deploy, is never
 * overwritten.
 */

import { readFileSync, writeFileSync } from 'fs';
import mongoose, { Types } from 'mongoose';
import Task from '../models/Task';

// No index creation on connect. autoIndex would create the declared pair index,
// and migrate-task-source-ref-identity.ts reads that index as proof the new code
// has booted. A backfill run must not manufacture that proof.
mongoose.set('autoIndex', false);

export const CREATED_BY_PREFIX = 'Created by ';

export type LeftNullReason =
  | 'no-created-by-first-update'
  | 'created-by-without-author'
  | 'created-by-not-its-author'
  | 'created-by-not-at-create';

// A real create writes the row and its init update in one request, a few
// milliseconds apart. A second is slack for that gap on either side. A wider gap
// is a later note, not the create, and a wrong stamp is a grant, so the window
// fails closed.
const CREATE_SLACK_MS = 1000;

interface RawTask {
  _id: Types.ObjectId;
  podId: Types.ObjectId;
  taskId: string;
  createdAt?: unknown;
  createdByUserId?: unknown;
  updates?: Array<{ text?: unknown; author?: unknown; authorId?: unknown; createdAt?: unknown }> | null;
}

export type CreatorDecision = { creatorId: string } | { reason: LeftNullReason };

// Index 0 only. The create path pushes the "Created by" update first, and
// assignedTaskWakeService trusts updates[0].authorId for the same question. A
// "Created by" update further down is not the creator's, and an authorId on any
// other first update belongs to whoever wrote it, so neither is trusted.
//
// Index 0 alone is not enough. A native or starter row has no init update, so
// its first update is whatever was written first, and a note can open with
// "Created by " too. So the text must name that update's own author, and the
// update must sit at the row's create. Both checks only remove rows from the
// stamp set.
export const decideCreator = (row: Pick<RawTask, 'createdAt' | 'updates'>): CreatorDecision => {
  const first = row.updates?.[0];
  if (!first || typeof first.text !== 'string' || !first.text.startsWith(CREATED_BY_PREFIX)) {
    return { reason: 'no-created-by-first-update' };
  }
  const creatorId = first.authorId === null || first.authorId === undefined ? '' : String(first.authorId).trim();
  if (!creatorId) return { reason: 'created-by-without-author' };
  // The name ends at the end of the text or at a space, so "wren2" is not "wren".
  const author = typeof first.author === 'string' ? first.author : '';
  const head = `${CREATED_BY_PREFIX}${author}`;
  if (!author || (first.text !== head && !first.text.startsWith(`${head} `))) {
    return { reason: 'created-by-not-its-author' };
  }
  const atCreate = row.createdAt instanceof Date && first.createdAt instanceof Date
    && Math.abs(first.createdAt.getTime() - row.createdAt.getTime()) <= CREATE_SLACK_MS;
  return atCreate ? { creatorId } : { reason: 'created-by-not-at-create' };
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
  // Frozen ids with no row at all. Always 0 for a full scan.
  missing: number;
  toStamp: StampPlan[];
  leftNull: LeftNullRow[];
}

// Shared by the full scan and the frozen-id plan, so both classify a row the same way.
function classify(rows: RawTask[], plan: BackfillPlan): void {
  rows.forEach((row) => {
    const decision = decideCreator(row);
    if ('creatorId' in decision) {
      plan.toStamp.push({ _id: row._id, podId: row.podId, taskId: row.taskId, creatorId: decision.creatorId });
    } else {
      plan.leftNull.push({ _id: row._id, podId: row.podId, taskId: row.taskId, reason: decision.reason });
    }
  });
}

// The raw collection, not the model. This branch's Task schema does not declare
// createdByUserId, and how a model filter on an undeclared path reaches the
// database depends on the strictQuery setting. The collection does what the
// filter says.
export async function planBackfill(): Promise<BackfillPlan> {
  const alreadyStamped = await Task.collection.countDocuments({ createdByUserId: { $ne: null } });
  // $slice keeps the scan to the one update that decides each row.
  const rows = (await Task.collection
    .find({ createdByUserId: null }, { projection: { podId: 1, taskId: 1, createdAt: 1, updates: { $slice: 1 } } })
    .toArray()) as unknown as RawTask[];
  const plan: BackfillPlan = { alreadyStamped, scanned: rows.length, missing: 0, toStamp: [], leftNull: [] };
  classify(rows, plan);
  return plan;
}

// The apply's plan. It reads only the frozen ids, so a row that became derivable
// after the dry run is never stamped by an apply that was given the older set.
export async function planForIds(ids: string[]): Promise<BackfillPlan> {
  const objectIds = [...new Set(ids)].map((id) => new Types.ObjectId(id));
  const rows = (await Task.collection
    .find(
      { _id: { $in: objectIds } },
      { projection: { podId: 1, taskId: 1, createdByUserId: 1, createdAt: 1, updates: { $slice: 1 } } },
    )
    .toArray()) as unknown as RawTask[];
  const isStamped = (row: RawTask) => row.createdByUserId !== null && row.createdByUserId !== undefined;
  const unstamped = rows.filter((row) => !isStamped(row));
  const plan: BackfillPlan = {
    alreadyStamped: rows.length - unstamped.length,
    scanned: unstamped.length,
    missing: objectIds.length - rows.length,
    toStamp: [],
    leftNull: [],
  };
  classify(unstamped, plan);
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

// `ids` is the frozen set. An apply without one is refused: a fresh compute would
// stamp whatever is derivable at that moment, which is not the set anyone reviewed.
export async function backfillTaskCreatedBy(
  options: { apply?: boolean; ids?: string[] } = {},
): Promise<BackfillSummary> {
  const apply = options.apply === true;
  if (apply && !options.ids) {
    throw new Error('apply needs a frozen id set (--ids <file>); a fresh compute is never applied');
  }
  // An empty file is almost always a failed redirect or the wrong file. Refuse it
  // here, so an empty set can never be mistaken for a missing one.
  if (apply && options.ids?.length === 0) {
    throw new Error('the frozen id set is empty (the --ids file has no ids): nothing to apply');
  }
  const plan = options.ids ? await planForIds(options.ids) : await planBackfill();
  const stamped = apply ? await writeStamps(plan.toStamp) : 0;
  return { apply, plan, stamped };
}

// One ObjectId per line, as the dry run writes them.
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

// Blank lines are skipped and a repeated id is kept once. The error names the
// line number, not its content, so a mistyped file is refused without echoing it.
export function parseIdsText(text: string): string[] {
  const ids = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;
    if (!OBJECT_ID.test(line)) throw new Error(`line ${index + 1} of the ids file is not an ObjectId`);
    ids.add(line);
  });
  return Array.from(ids);
}

export const renderIdsText = (ids: string[]): string => (ids.length ? `${ids.join('\n')}\n` : '');

// The dry run's ids file is the reviewed record, so an existing file is never
// overwritten. 'wx' refuses it, and the error says what to do.
export function writeIdsFile(outPath: string, ids: string[]): void {
  try {
    writeFileSync(outPath, renderIdsText(ids), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${outPath} already exists: pick a new --out path. The reviewed ids file is never overwritten.`);
    }
    throw error;
  }
}

export interface CliOptions {
  apply: boolean;
  idsPath?: string;
  outPath?: string;
}

// Refuses an apply without a frozen set, and an out file on an apply, before any
// database connection is opened.
export function parseArgs(argv: string[]): CliOptions {
  const pathAfter = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    if (at === -1) return undefined;
    const path = argv[at + 1];
    if (!path || path.startsWith('--')) throw new Error(`${flag} needs a file path`);
    return path;
  };
  const options: CliOptions = {
    apply: argv.includes('--apply'),
    idsPath: pathAfter('--ids'),
    outPath: pathAfter('--out'),
  };
  if (options.apply && !options.idsPath) {
    throw new Error('--apply needs --ids <file>: only a frozen id set is applied');
  }
  if (options.apply && options.outPath) {
    throw new Error('--out is for the dry run only: it does not go with --apply');
  }
  return options;
}

const LIST_CAP = 20;

// ids only: podId and taskId, never a title, a note or an author.
function printSummary({ apply, plan, stamped }: BackfillSummary): void {
  const count = (reason: LeftNullReason) => plan.leftNull.filter((row) => row.reason === reason).length;
  console.log(apply
    ? '[backfill-task-created-by] APPLIED'
    : '[backfill-task-created-by] DRY RUN — nothing written. Apply the id set with --apply --ids <file>.');
  console.log(`already stamped (skipped):        ${plan.alreadyStamped}`);
  console.log(`unstamped rows scanned:           ${plan.scanned}`);
  if (plan.missing > 0) console.log(`frozen ids with no row:           ${plan.missing}`);
  console.log(`creator derivable (to stamp):     ${plan.toStamp.length}`);
  console.log(`left null (not derivable):        ${plan.leftNull.length}`);
  console.log(`  no "Created by" first update:   ${count('no-created-by-first-update')}`);
  console.log(`  "Created by" without an author: ${count('created-by-without-author')}`);
  console.log(`  "Created by" not its author's:  ${count('created-by-not-its-author')}`);
  console.log(`  "Created by" not at create:     ${count('created-by-not-at-create')}`);
  if (apply) console.log(`stamped:                          ${stamped}`);
  if (plan.leftNull.length > 0) {
    console.log(`left-null rows, podId taskId reason (first ${LIST_CAP}):`);
    plan.leftNull.slice(0, LIST_CAP).forEach((row) => {
      console.log(`  ${row.podId.toString()} ${row.taskId} ${row.reason}`);
    });
    if (plan.leftNull.length > LIST_CAP) console.log(`  … and ${plan.leftNull.length - LIST_CAP} more`);
  }
}

// argv is a parameter so the service test can drive the --out path against its own mongod.
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  const ids = options.idsPath ? parseIdsText(readFileSync(options.idsPath, 'utf8')) : undefined;
  await mongoose.connect(mongoUri);
  try {
    const summary = await backfillTaskCreatedBy({ apply: options.apply, ids });
    printSummary(summary);
    if (!summary.apply) {
      const toStamp = summary.plan.toStamp.map((row) => row._id.toString());
      console.log(`ids it would write (${toStamp.length}):`);
      toStamp.forEach((id) => console.log(id));
      if (options.outPath) writeIdsFile(options.outPath, toStamp);
    }
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
