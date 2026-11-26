/**
 * Count the grants that record no owner (`ownerId` null or absent), by target
 * kind and status. The owner checks at use and the account-deletion revoke
 * (F660, F664) match grants by owner, so these rows are outside both; this
 * measures how many there are before anyone decides what to do with them.
 *
 * Read-only. Prints counts only: no grant ids, connection ids or people.
 *   MONGO_URI=... npx ts-node scripts/count-unowned-grants.ts
 */
/* eslint-disable no-console */
const mongoose = require('mongoose');

export type GrantStatus = 'live' | 'revoked' | 'expired';

export interface UnownedGrantCount {
  kind: string;
  status: GrantStatus;
  count: number;
}

/** Counts per (target kind, status). Revoked wins over expired. */
export const countUnownedGrants = async (now: Date = new Date()): Promise<UnownedGrantCount[]> => {
  // eslint-disable-next-line global-require
  const RoomGrant = require('../models/RoomGrant');
  const rows = await RoomGrant.aggregate([
    { $match: { ownerId: null } },
    {
      $project: {
        kind: { $ifNull: ['$target.kind', 'unknown'] },
        status: {
          $switch: {
            branches: [
              { case: { $ne: [{ $ifNull: ['$revokedAt', null] }, null] }, then: 'revoked' },
              { case: { $lte: ['$expiresAt', now] }, then: 'expired' },
            ],
            default: 'live',
          },
        },
      },
    },
    { $group: { _id: { kind: '$kind', status: '$status' }, count: { $sum: 1 } } },
  ]) as Array<{ _id: { kind: string; status: GrantStatus }; count: number }>;
  return rows
    .map((row) => ({ kind: String(row._id.kind), status: row._id.status, count: row.count }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.status.localeCompare(b.status));
};

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const counts = await countUnownedGrants();
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    console.log(JSON.stringify({ total, byKindAndStatus: counts }));
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('count-unowned-grants failed:', (error as Error)?.message || error);
    process.exit(1);
  });
}
