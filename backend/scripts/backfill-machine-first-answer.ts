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
 *  - Bounded (`--limit`, default 500 machines) and paced (`--pace-ms`, default
 *    100 ms between machines): one machine at a time, one Postgres read each.
 *  - Prints counts only: no machine, agent or owner names or ids.
 *
 * Runs in the ops-runner, never by exec into the serving backend
 * (docs/runbooks/ops-runner-and-no-exec-into-backend.md):
 *   cd backend && node dist/scripts/backfill-machine-first-answer.js               # dry run
 *   cd backend && node dist/scripts/backfill-machine-first-answer.js --apply
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

export interface MachineFirstAnswerDeps {
  listUnstamped: (limit: number) => Promise<UnstampedMachine[]>;
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
}

export const DEFAULT_LIMIT = 500;
export const DEFAULT_PACE_MS = 100;

export async function backfillMachineFirstAnswer(
  deps: MachineFirstAnswerDeps,
  options: { apply?: boolean; limit?: number; paceMs?: number } = {},
): Promise<MachineFirstAnswerReport> {
  const apply = options.apply === true;
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const paceMs = options.paceMs !== undefined && options.paceMs >= 0 ? options.paceMs : DEFAULT_PACE_MS;
  const machines = await deps.listUnstamped(limit);
  const report: MachineFirstAnswerReport = {
    dryRun: !apply,
    unstamped: machines.length,
    noAgents: 0,
    noPosts: 0,
    toStamp: 0,
    applied: 0,
    alreadyStamped: 0,
    failed: 0,
  };
  for (const [index, machine] of machines.entries()) {
    // eslint-disable-next-line no-await-in-loop
    if (index > 0 && paceMs > 0) await deps.pause(paceMs);
    try {
      // eslint-disable-next-line no-await-in-loop
      const agentIds = await deps.agentIdsOn(machine.machineId);
      if (agentIds.length === 0) {
        report.noAgents += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const first = await deps.earliestPost(agentIds, machine.createdAt);
      if (!first) {
        report.noPosts += 1;
        continue;
      }
      report.toStamp += 1;
      if (!apply) continue;
      // eslint-disable-next-line no-await-in-loop
      const changed = await deps.stamp(machine.id, first);
      if (changed > 0) report.applied += 1;
      else report.alreadyStamped += 1;
    } catch (error) {
      // Counted, not named: the message is the driver's, never an id we print.
      report.failed += 1;
      console.error('[backfill-machine-first-answer] one machine failed:', (error as Error).message);
    }
  }
  return report;
}

export const productionDeps = (pool: PgPool | null): MachineFirstAnswerDeps => ({
  listUnstamped: async (limit) => {
    const rows = await Machine.find({ firstAnswerAt: null })
      .sort({ createdAt: 1 })
      .limit(limit)
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
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const report = await backfillMachineFirstAnswer(productionDeps(pool), {
      apply, limit: argNumber('--limit'), paceMs: argNumber('--pace-ms'),
    });
    console.log(`[backfill-machine-first-answer] ${JSON.stringify(report)}`);
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
