#!/usr/bin/env node
/*
 * Clean the two dead classes out of the PG `pod_members` mirror.
 *
 * Since TASK-162 the authorisation decision is Mongo (`utils/isPodMember` read
 * through the controller), and PG `pod_members` is a cache the PG listing
 * surfaces still read. Rows that no longer correspond to anything are inert —
 * they decide nothing — but they mislead anyone reading the mirror, so the
 * hygiene pass removes exactly two classes and names what it leaves:
 *
 *   legitimate : the pod exists in Mongo AND lists the user  → keep
 *   ghost      : the pod exists in Mongo, the user is not listed  → delete
 *   orphan     : Mongo has no pod with that id  → delete
 *
 * Three properties this script is built to have, because it writes to
 * production data:
 *
 *   1. Two numbers, not one. It prints rows examined and rows deleted, and it
 *      re-reads the row count afterwards: `before - after === deleted`. A run
 *      that matched nothing and a DELETE with a broken WHERE both report a
 *      cheerful "0 ghosts" otherwise.
 *   2. The survivor is the discriminating observation. The dry run names one
 *      row in each class, so a run can be checked by looking at what is still
 *      there — a script that deletes every row passes "0 ghosts remain".
 *   3. The orphan predicate is separate from the ghost one, and a read failure
 *      fails closed. A transient Mongo failure must not read as "the pod does
 *      not exist", which would turn the orphan sweep into the whole table.
 *      A malformed pod id cannot name a Mongo pod at all, so that one case is
 *      classified as an orphan rather than as a failure to read.
 *
 * Idempotent: a second run finds nothing to delete. Dry run by default; pass
 * `--apply` to write. Run it on the operator's word, never inline in a deploy.
 *
 * Usage:
 *   ts-node backend/scripts/cleanup-ghost-pod-members.ts           # report
 *   ts-node backend/scripts/cleanup-ghost-pod-members.ts --apply   # delete
 */

import mongoose from 'mongoose';
import MongoPod from '../models/Pod';
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { isListedPodMember } = require('../utils/isPodMember');

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MemberRow {
  podId: string;
  userId: string;
}

export interface CleanupReport {
  dryRun: boolean;
  /** Rows read from `pod_members` before anything was written. */
  examined: number;
  legitimate: number;
  ghost: number;
  orphan: number;
  /** Rows whose pod could not be read for a reason that is not "not found". */
  unreadable: number;
  unreadablePodIds: string[];
  toDelete: MemberRow[];
  deleted: number;
  /** Row count after the sweep; `null` in a dry run. */
  remaining: number | null;
  /** `examined - remaining === deleted`. `null` in a dry run. */
  reconciled: boolean | null;
  /** True when the run refused to write because something could not be read. */
  refused: boolean;
  examples: { legitimate: MemberRow | null; ghost: MemberRow | null; orphan: MemberRow | null };
}

const loadPool = (): PgPool => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg') as { pool: PgPool };
  return pool;
};

const readMemberRows = async (pool: PgPool): Promise<MemberRow[]> => {
  const result = await pool.query('SELECT pod_id, user_id FROM pod_members');
  return result.rows.map((r) => ({
    podId: String(r.pod_id),
    userId: String(r.user_id),
  }));
};

const countMemberRows = async (pool: PgPool): Promise<number> => {
  const result = await pool.query('SELECT count(*)::int AS n FROM pod_members');
  return Number((result.rows[0] as { n?: number }).n ?? 0);
};

const deleteMemberRow = async (pool: PgPool, row: MemberRow): Promise<void> => {
  await pool.query('DELETE FROM pod_members WHERE pod_id = $1 AND user_id = $2', [
    row.podId,
    row.userId,
  ]);
};

export async function cleanupGhostPodMembers(
  options: { dryRun?: boolean } = {},
): Promise<CleanupReport> {
  const dryRun = options.dryRun !== false;
  const pool = loadPool();

  const rows = await readMemberRows(pool);

  const report: CleanupReport = {
    dryRun,
    examined: rows.length,
    legitimate: 0,
    ghost: 0,
    orphan: 0,
    unreadable: 0,
    unreadablePodIds: [],
    toDelete: [],
    deleted: 0,
    remaining: null,
    reconciled: null,
    refused: false,
    examples: { legitimate: null, ghost: null, orphan: null },
  };

  const rowsByPod = new Map<string, MemberRow[]>();
  for (const row of rows) {
    const bucket = rowsByPod.get(row.podId);
    if (bucket) bucket.push(row);
    else rowsByPod.set(row.podId, [row]);
  }

  for (const [podId, podRows] of rowsByPod) {
    let doc: { members?: unknown[] } | null = null;
    try {
      doc = (await MongoPod.findById(podId).select('members').lean()) as { members?: unknown[] } | null;
    } catch (err) {
      // Fail closed. "Cannot read this pod" is not "this pod does not exist":
      // the second reading authorises a delete, so a transient failure must
      // never be allowed to take on that meaning.
      if ((err as { name?: string })?.name === 'CastError') {
        // A pod id Mongo cannot even parse cannot name a pod. Same class as
        // an id Mongo does not have, and not a failure to read.
        report.orphan += podRows.length;
        report.toDelete.push(...podRows);
        if (!report.examples.orphan) report.examples.orphan = podRows[0];
        continue;
      }
      report.unreadable += podRows.length;
      report.unreadablePodIds.push(podId);
      continue;
    }

    if (doc === null) {
      report.orphan += podRows.length;
      report.toDelete.push(...podRows);
      if (!report.examples.orphan) report.examples.orphan = podRows[0];
      continue;
    }

    for (const row of podRows) {
      if (isListedPodMember(doc, row.userId)) {
        report.legitimate += 1;
        if (!report.examples.legitimate) report.examples.legitimate = row;
      } else {
        report.ghost += 1;
        report.toDelete.push(row);
        if (!report.examples.ghost) report.examples.ghost = row;
      }
    }
  }

  if (report.unreadable > 0) {
    // Refuse the whole write rather than sweeping the pods that did read: a
    // partial delete over a store we could not fully observe is not a result
    // the operator can check against a pre-state.
    report.refused = true;
    return report;
  }

  if (dryRun) return report;

  for (const row of report.toDelete) {
    await deleteMemberRow(pool, row);
    report.deleted += 1;
  }
  report.remaining = await countMemberRows(pool);
  report.reconciled = report.examined - report.remaining === report.deleted;
  return report;
}

const describe = (label: string, row: MemberRow | null): string => (
  row ? `${label}: pod=${row.podId} user=${row.userId}` : `${label}: none in this run`
);

/**
 * The exit status for a finished run.
 *
 * Two conditions must not read as success to a scripted caller, and they are not
 * interchangeable: `refused` (2) means nothing was written, so a re-run is safe;
 * a failed reconciliation (3) can only be discovered *after* rows are gone, so it
 * means inspect the store before touching it again. Distinct codes so the caller
 * can tell those apart without parsing the log. Refusal wins if both are somehow
 * true — it is the state in which the sweep did not happen at all.
 *
 * TASK-167 gate: the report already knew about a divergence; the process did not.
 */
export function exitCodeFor(report: CleanupReport): number {
  if (report.refused) return 2;
  if (report.reconciled === false) return 3;
  return 0;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const dryRun = !argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI ?? '');

  const r = await cleanupGhostPodMembers({ dryRun });

  console.log(`[pod-members] ${dryRun ? 'DRY RUN (pass --apply to delete)' : 'APPLIED'}`);
  console.log(`[pod-members] examined        : ${r.examined}`);
  console.log(`[pod-members] legitimate keep : ${r.legitimate}`);
  console.log(`[pod-members] ghost delete    : ${r.ghost}`);
  console.log(`[pod-members] orphan delete   : ${r.orphan}`);
  const unreadableIds = r.unreadablePodIds.length ? ` (${r.unreadablePodIds.join(', ')})` : '';
  console.log(`[pod-members] unreadable      : ${r.unreadable}${unreadableIds}`);
  console.log(`[pod-members] deleted         : ${r.deleted}`);
  console.log(`[pod-members] remaining       : ${r.remaining === null ? '(dry run)' : r.remaining}`);
  const reconciled = r.reconciled === null
    ? '(dry run)'
    : `${r.reconciled} (${r.examined} - ${r.remaining} === ${r.deleted})`;
  console.log(`[pod-members] reconciles      : ${reconciled}`);
  console.log(`[pod-members] ${describe('example ghost', r.examples.ghost)}`);
  console.log(`[pod-members] ${describe('example orphan', r.examples.orphan)}`);
  console.log(`[pod-members] ${describe('example legitimate', r.examples.legitimate)}`);

  if (r.refused) {
    console.error(
      `[pod-members] REFUSED: ${r.unreadable} row(s) could not be classified because their pod`
      + ' could not be read. Nothing was deleted.',
    );
  }
  if (r.reconciled === false) {
    console.error(
      `[pod-members] RECONCILIATION FAILED: after deleting ${r.deleted} of ${r.examined}`
      + ` examined row(s), the store holds ${r.remaining}. It did not lose exactly what this run`
      + ' deleted. Inspect the store before re-running.',
    );
  }
  // Set once, from the one function that decides status, so a new condition
  // cannot be added to the log without being added to the exit code.
  process.exitCode = exitCodeFor(r);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[pod-members] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      mongoose.connection.close().catch(() => {});
    });
}
