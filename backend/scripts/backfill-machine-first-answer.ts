/**
 * Give a daemon machine with no `firstAnswerAt` the time its agents first
 * posted (F639).
 *
 * Why. Until F639 the stamp came only from an event ack that reported
 * `posted` on a person-waiting event. A seat that answered through a tool, or
 * answered a person's plain message (a `message.posted` wake), posted for real
 * and left the machine reading "not answered", so the BYO funnel undercounts
 * first answers. New posts stamp from every agent post path now; this fills in
 * the machines whose agents answered before that.
 *
 * What it sets. For each machine with `firstAnswerAt` unset: the agents bound
 * to it now (`User.botMetadata.machineId`, the same link the post-path stamp
 * reads), then the earliest chat message any of them wrote in Postgres at or
 * after the machine was registered. A system line stored under the agent and a
 * kernel notice (`author_kind = 'kernel'`) are not the agent posting, so they
 * don't count, and neither does a message in an `agent-dm` pod: no person is
 * in one, and the first answer is a person seeing their agent answer. A
 * machine whose agents never posted is left alone.
 *
 * What it can't see. An agent rebound from another computer brings messages it
 * posted there; the registration-time floor keeps anything older than this
 * machine out, but not a post from an older machine registered earlier. Thread
 * comments on posts live in Mongo and are not read; a machine whose agents only
 * ever commented stays unset until its next post.
 *
 * Safety.
 *  - Dry run by default; `--apply` writes.
 *  - Each write is `{ _id, firstAnswerAt: null }`, so a stamp a live post wrote
 *    in the meantime is never overwritten. Re-running is harmless.
 *  - Pages the whole unstamped set in one run, in batches (`--batch`, default
 *    100) on a `(createdAt, _id)` cursor, so machines that stay unset (no
 *    agents, no eligible post) never hide newer ones. `--limit` (default 500)
 *    caps the machines one run reads; paced (`--pace-ms`, default 100 ms
 *    between machines), one machine at a time, one Postgres read each.
 *  - Resumable: the report's `nextCursor` is `<createdAt ISO>_<machine row id>`
 *    (null once the set is done); pass it back as `--after <cursor>`.
 *  - Prints counts and that cursor only: no machine, agent or owner names.
 *
 * Runs in the ops-runner, never by exec into the serving backend
 * (docs/runbooks/ops-runner-and-no-exec-into-backend.md):
 *   cd backend && node dist/scripts/backfill-machine-first-answer.js               # dry run
 *   cd backend && node dist/scripts/backfill-machine-first-answer.js --apply
 *   cd backend && node dist/scripts/backfill-machine-first-answer.js --apply --after <nextCursor>
 */
/* eslint-disable no-console */

import mongoose from 'mongoose';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Machine = require('../models/Machine');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');

interface PgPool {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end?: () => Promise<void>;
}

export interface UnstampedMachine {
  id: string;
  machineId: string;
  createdAt: Date;
}

/** Where a page starts: strictly after this `(createdAt, _id)`. */
export interface MachineCursor {
  createdAt: Date;
  id: string;
}

export interface MachineFirstAnswerDeps {
  /** Unstamped machines after `after`, in `(createdAt, _id)` order, at most `size`. */
  listUnstamped: (after: MachineCursor | null, size: number) => Promise<UnstampedMachine[]>;
  agentIdsOn: (machineId: string) => Promise<string[]>;
  earliestPost: (agentIds: string[], since: Date) => Promise<Date | null>;
  /** Rows changed: 0 when a live post stamped the machine first. */
  stamp: (id: string, at: Date) => Promise<number>;
  pause: (ms: number) => Promise<void>;
}

export interface MachineFirstAnswerReport {
  dryRun: boolean;
  unstamped: number;
  noAgents: number;
  noPosts: number;
  toStamp: number;
  applied: number;
  alreadyStamped: number;
  failed: number;
  /** Resume point for `--after`; null when the unstamped set was read to its end. */
  nextCursor: string | null;
}

export const DEFAULT_LIMIT = 500;
export const DEFAULT_BATCH = 100;
export const DEFAULT_PACE_MS = 100;

export const formatCursor = (cursor: MachineCursor): string => `${cursor.createdAt.toISOString()}_${cursor.id}`;

export const parseCursor = (raw: string): MachineCursor => {
  const match = /^(.+)_([a-f0-9]{24})$/i.exec(raw);
  const createdAt = match ? new Date(match[1]) : null;
  if (!match || !createdAt || Number.isNaN(createdAt.getTime())) {
    throw new Error('--after takes a cursor printed by an earlier run: <createdAt ISO>_<24-hex id>');
  }
  return { createdAt, id: match[2] };
};

export async function backfillMachineFirstAnswer(
  deps: MachineFirstAnswerDeps,
  options: {
    apply?: boolean; limit?: number; batch?: number; paceMs?: number; after?: MachineCursor | null;
  } = {},
): Promise<MachineFirstAnswerReport> {
  const apply = options.apply === true;
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const batch = options.batch && options.batch > 0 ? options.batch : DEFAULT_BATCH;
  const paceMs = options.paceMs !== undefined && options.paceMs >= 0 ? options.paceMs : DEFAULT_PACE_MS;
  const report: MachineFirstAnswerReport = {
    dryRun: !apply,
    unstamped: 0,
    noAgents: 0,
    noPosts: 0,
    toStamp: 0,
    applied: 0,
    alreadyStamped: 0,
    failed: 0,
    nextCursor: null,
  };
  let cursor: MachineCursor | null = options.after || null;
  let exhausted = false;
  while (report.unstamped < limit) {
    const size = Math.min(batch, limit - report.unstamped);
    // eslint-disable-next-line no-await-in-loop
    const page = await deps.listUnstamped(cursor, size);
    for (const machine of page) {
      // eslint-disable-next-line no-await-in-loop
      if (report.unstamped > 0 && paceMs > 0) await deps.pause(paceMs);
      report.unstamped += 1;
      cursor = { createdAt: machine.createdAt, id: machine.id };
      // eslint-disable-next-line no-await-in-loop
      await processMachine(deps, machine, apply, report);
    }
    if (page.length < size) {
      exhausted = true;
      break;
    }
  }
  report.nextCursor = !exhausted && cursor ? formatCursor(cursor) : null;
  return report;
}

async function processMachine(
  deps: MachineFirstAnswerDeps,
  machine: UnstampedMachine,
  apply: boolean,
  report: MachineFirstAnswerReport,
): Promise<void> {
  try {
    const agentIds = await deps.agentIdsOn(machine.machineId);
    if (agentIds.length === 0) {
      report.noAgents += 1;
      return;
    }
    const first = await deps.earliestPost(agentIds, machine.createdAt);
    if (!first) {
      report.noPosts += 1;
      return;
    }
    report.toStamp += 1;
    if (!apply) return;
    const changed = await deps.stamp(machine.id, first);
    if (changed > 0) report.applied += 1;
    else report.alreadyStamped += 1;
  } catch (error) {
    // Counted, not named: the message is the driver's, never an id we print.
    report.failed += 1;
    console.error('[backfill-machine-first-answer] one machine failed:', (error as Error).message);
  }
}

export const productionDeps = (pool: PgPool | null): MachineFirstAnswerDeps => ({
  listUnstamped: async (after, size) => {
    const filter: Record<string, unknown> = { firstAnswerAt: null };
    if (after) {
      const id = new mongoose.Types.ObjectId(after.id);
      filter.$or = [
        { createdAt: { $gt: after.createdAt } },
        { createdAt: after.createdAt, _id: { $gt: id } },
      ];
    }
    const rows = await Machine.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(size)
      .select('_id machineId createdAt')
      .lean() as Array<{ _id: unknown; machineId: string; createdAt?: Date }>;
    return rows.map((row) => ({
      id: String(row._id),
      machineId: row.machineId,
      createdAt: row.createdAt ? new Date(row.createdAt) : new Date(0),
    }));
  },
  agentIdsOn: async (machineId) => {
    const rows = await User.find({ isBot: true, 'botMetadata.machineId': machineId })
      .select('_id').lean() as Array<{ _id: unknown }>;
    return rows.map((row) => String(row._id));
  },
  earliestPost: async (agentIds, since) => {
    if (!pool || agentIds.length === 0) return null;
    // An agent-dm pod holds two agents and no person (ADR-001 §3.10), so a
    // post there is nobody's answer. The type is read from the Mongo Pod, the
    // canonical row; the Postgres pods mirror can drift. Bounded by these
    // agents' own DMs.
    const dmPods = await Pod.find({ type: 'agent-dm', members: { $in: agentIds } })
      .select('_id').lean() as Array<{ _id: unknown }>;
    const excludedPodIds = dmPods.map((pod) => String(pod._id));
    // ORDER BY + LIMIT 1 walks idx_messages_created_at from the machine's
    // registration and stops at the first match.
    const { rows } = await pool.query(
      `SELECT created_at FROM messages
        WHERE user_id = ANY($1::text[])
          AND created_at >= $2
          AND message_type <> 'system'
          AND (author_kind IS NULL OR author_kind <> 'kernel')
          AND (pod_id IS NULL OR NOT (pod_id = ANY($3::text[])))
        ORDER BY created_at ASC
        LIMIT 1`,
      [agentIds, since, excludedPodIds],
    );
    const value = rows[0]?.created_at;
    return value ? new Date(value as string) : null;
  },
  stamp: async (id, at) => {
    const res = await Machine.updateOne({ _id: id, firstAnswerAt: null }, { $set: { firstAnswerAt: at } });
    if (res?.acknowledged === false) throw new Error('write was not acknowledged');
    return res?.modifiedCount ?? 0;
  },
  pause: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
});

const argValue = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const argNumber = (flag: string): number | undefined => {
  const at = process.argv.indexOf(flag);
  if (at < 0) return undefined;
  const value = Number(process.argv[at + 1]);
  return Number.isFinite(value) ? value : undefined;
};

export async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };
  if (!pool) throw new Error('Postgres is required: agent chat messages live there');
  const apply = process.argv.includes('--apply');
  const afterRaw = argValue('--after');
  const after = afterRaw ? parseCursor(afterRaw) : null;
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const report = await backfillMachineFirstAnswer(productionDeps(pool), {
      apply, limit: argNumber('--limit'), batch: argNumber('--batch'), paceMs: argNumber('--pace-ms'), after,
    });
    console.log(`[backfill-machine-first-answer] ${JSON.stringify(report)}`);
    if (report.nextCursor) console.log(`More machines remain: re-run with --after ${report.nextCursor}`);
    if (!apply) console.log('DRY RUN — nothing written. Re-run with --apply.');
    if (report.failed > 0) throw new Error(`${report.failed} machine(s) failed; re-running retries them`);
  } finally {
    await mongoose.disconnect();
    if (pool.end) await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('machine first-answer backfill failed:', (error as Error).message);
    process.exit(1);
  });
}
