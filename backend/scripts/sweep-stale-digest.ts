/**
 * Mark ambient digest rows older than a day as read.
 *
 * Until the backlog settle landed, a consumed wake settled only the digest
 * rows it quoted (at most 9, oldest first), and a NO_REPLY the server reduced
 * to `silent_or_empty` settled none. About 1,000 rows arrive per seat per day,
 * so the backlog only grew: 22,568 pending fleet-wide on 2026-10-25, the oldest
 * 31 hours old, each one keeping an hourly unread-digest heartbeat alive. The
 * fix settles a pod's whole backlog on each consumed wake; this clears what
 * built up before it.
 *
 * A digest row is context, never a task, and nothing waits on one a day old.
 * Wake rows are never touched.
 *
 * Dry run is the default (`--dry-run` says so explicitly and beats `--apply`):
 *   npm run sweep:stale-digest
 * Apply:
 *   npm run sweep:stale-digest -- --apply
 */
/* eslint-disable no-console */
import mongoose from 'mongoose';
import AgentEvent from '../models/AgentEvent';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SWEEP_REASON = 'stale-digest-sweep';

export type StaleDigestSeat = { agentName: string; instanceId: string; count: number };
export type StaleDigestResult = {
  apply: boolean;
  cutoff: string;
  matched: number;
  settled: number;
  seats: StaleDigestSeat[];
};

export const parseArgs = (argv: string[]): { apply: boolean } => ({
  apply: argv.includes('--apply') && !argv.includes('--dry-run'),
});

export const sweepStaleDigest = async ({
  apply = false,
  now = new Date(),
  olderThanMs = DAY_MS,
}: { apply?: boolean; now?: Date; olderThanMs?: number } = {}): Promise<StaleDigestResult> => {
  const cutoff = new Date(now.getTime() - olderThanMs);
  // `delivered` too: a companion claimed beside a wake that never consumed
  // waits there for the requeue, and is just as stale.
  const filter = {
    deliveryMode: 'digest',
    status: { $in: ['pending', 'delivered'] },
    createdAt: { $lt: cutoff },
  };
  const grouped = await AgentEvent.aggregate<{ _id: { agentName: string; instanceId: string }; count: number }>([
    { $match: filter },
    { $group: { _id: { agentName: '$agentName', instanceId: '$instanceId' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const seats = grouped.map((row) => ({
    agentName: row._id.agentName, instanceId: row._id.instanceId || 'default', count: row.count,
  }));
  const matched = seats.reduce((sum, seat) => sum + seat.count, 0);
  let settled = 0;
  if (apply && matched) {
    const updated = await AgentEvent.updateMany(filter, {
      $set: {
        status: 'acked',
        deliveredAt: now,
        deliveryNonce: null,
        delivery: { outcome: 'no_action', reason: SWEEP_REASON, reasonRecorded: true, updatedAt: now },
      },
    });
    settled = updated.modifiedCount;
  }
  return { apply, cutoff: cutoff.toISOString(), matched, settled, seats };
};

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  const { apply } = parseArgs(process.argv.slice(2));
  await mongoose.connect(process.env.MONGO_URI);
  try {
    console.log(JSON.stringify(await sweepStaleDigest({ apply })));
    if (!apply) console.log('DRY RUN — no digest rows changed. Re-run with --apply after review.');
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('stale digest sweep failed:', error);
    process.exit(1);
  });
}
