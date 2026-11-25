import { Types } from 'mongoose';
import NeedsYouEmailQuota from '../models/NeedsYouEmailQuota';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'NeedsYouEmailQuota';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('needs_you_email_quotas: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for the per-recipient daily cap on needs-you emails, selected
 * by STORE_MODE_NEEDS_YOU_EMAIL_QUOTA. Table:
 * config/migrations/0020_needs_you_email_quotas.sql. Built on first use
 * outside mongo, so mongo mode loads nothing new.
 */
export function emailQuotaStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: NeedsYouEmailQuota,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'needs_you_email_quotas',
      idColumn: 'id',
      columns: ['recipient_user_id', 'day', 'count'],
    }),
    toRow: (doc) => ({
      id: String(doc._id),
      recipient_user_id: String(doc.recipientUserId),
      day: doc.day,
      count: doc.count ?? 0,
    }),
    // The plain shape a lean Mongo read returns: ObjectIds, the day string, the count.
    fromRow: (row) => ({
      _id: new Types.ObjectId(String(row.id)),
      recipientUserId: new Types.ObjectId(String(row.recipient_user_id)),
      day: row.day,
      count: Number(row.count),
    }),
  });
  return store;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

/**
 * Takes one of the recipient's `limit` email slots for `day` (YYYY-MM-DD).
 * True when this call took one; false when the day's slots are all taken.
 *
 * No more than `limit` racing callers ever get a slot, in every mode: the
 * day's document is created once (its (recipientUserId, day) key is unique),
 * and each slot is one atomic conditional increment that matches only below
 * the limit. mongo makes the pre-step-2 upsert, whose duplicate-key loser
 * goes on to contend for a slot, then the conditional $inc. dual and pg-read
 * make the same two writes through the helper's insertIfAbsent and
 * updateWhere. pg refuses until step 4, before any write.
 */
export async function claimEmailSlot(
  recipientUserId: unknown,
  day: string,
  limit: number,
): Promise<boolean> {
  if (storeMode(NAME) === 'mongo') {
    try {
      await NeedsYouEmailQuota.updateOne(
        { recipientUserId, day },
        { $setOnInsert: { count: 0 } }, { upsert: true },
      );
    } catch (error) {
      // Another worker won the day's unique row. Both can contend for one of
      // its slots below; no slot past the limit can be claimed.
      if (!isDuplicateKey(error)) throw error;
    }
    const slot = await NeedsYouEmailQuota.findOneAndUpdate(
      { recipientUserId, day, count: { $lt: limit } },
      { $inc: { count: 1 } }, { new: true },
    );
    return Boolean(slot);
  }
  const quotaStore = emailQuotaStore();
  await quotaStore.insertIfAbsent({ recipientUserId, day }, { count: 0 });
  // The filter runs on Mongo only; the increment is the pipeline form of $inc.
  return quotaStore.updateWhere(
    { recipientUserId, day, count: { $lt: limit } },
    [{ $set: { count: { $add: [{ $ifNull: ['$count', 0] }, 1] } } }],
  );
}
