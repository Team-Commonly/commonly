import { Types } from 'mongoose';
import BillingEvent from '../models/BillingEvent';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'BillingEvent';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('billing_events: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for the Stripe webhook idempotency marker, selected by
 * STORE_MODE_BILLING_EVENT. Table: config/migrations/0022_billing_events.sql.
 * Built on first use outside mongo, so mongo mode loads nothing new.
 *
 * `toRow` runs after the claim's Mongo insert has committed. The helper maps
 * inside the copy's try, so a throw is a failed copy for repair, never a
 * failed claim; this toRow only reads fields and maps a missing one to null,
 * so it doesn't throw either.
 */
export function billingEventStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: BillingEvent,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'billing_events',
      idColumn: 'id',
      columns: ['event_id', 'type', 'customer_id', 'user_id', 'outcome', 'detail', 'created_at'],
    }),
    toRow: (doc) => ({
      id: String(doc._id),
      event_id: doc.eventId ?? null,
      type: doc.type ?? null,
      customer_id: doc.customerId ?? null,
      user_id: doc.userId == null ? null : String(doc.userId),
      outcome: doc.outcome ?? null,
      detail: doc.detail ?? null,
      created_at: doc.createdAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: ObjectIds, and no optional field until it is set.
    fromRow: (row) => ({
      _id: new Types.ObjectId(String(row.id)),
      eventId: row.event_id,
      type: row.type,
      ...(row.customer_id == null ? {} : { customerId: row.customer_id }),
      ...(row.user_id == null ? {} : { userId: new Types.ObjectId(String(row.user_id)) }),
      outcome: row.outcome,
      ...(row.detail == null ? {} : { detail: row.detail }),
      ...(row.created_at == null ? {} : { createdAt: new Date(row.created_at as string) }),
    }),
  });
  return store;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

const notYetInPg = (method: string) => new Error(`dual-store: ${NAME} ${method} is not supported in pg mode`
  + ' until step 4 (docs/runbooks/adr-034-model-move.md)');

/**
 * Takes the idempotency lock for one Stripe event: true when this call
 * claimed it, false when the event id was already claimed (a duplicate
 * delivery, which must not be processed again).
 *
 * The unique index on `eventId` in Mongo is the lock in every mode that runs
 * today. mongo makes the pre-step-2 `create`. dual and pg-read insert through
 * the helper's `create`, whose duplicate key propagates from Mongo before any
 * copy; a copy that fails after the insert never fails the claim (the marker
 * stays for `repair`). pg refuses until step 4, before any write, so a refused
 * delivery is retried by Stripe and can claim later.
 */
export async function claimBillingEvent(eventId: string, type: string): Promise<boolean> {
  const mode = storeMode(NAME);
  if (mode === 'pg') throw notYetInPg('claimBillingEvent');
  const doc = {
    eventId, type, outcome: 'ignored', detail: 'claimed',
  };
  try {
    if (mode === 'mongo') await BillingEvent.create(doc);
    else await billingEventStore().create(doc);
    return true;
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
}

export interface BillingOutcomeFields {
  outcome: string;
  detail?: string;
  customerId?: string;
  userId?: unknown;
}

/**
 * Records how a claimed event was handled. `fields` is the `$set`: a key whose
 * value is undefined writes nothing, as Mongoose drops it from `$set`, so an
 * absent customerId never becomes null.
 *
 * mongo makes the pre-step-2 `updateOne` with `fields` as passed. dual and
 * pg-read make the helper's `updateWhere` on `{ eventId }` with the defined
 * fields as `$literal`s; the pipeline is not cast by the schema, so userId is
 * cast to an ObjectId here. pg refuses until step 4 (updateWhere does).
 */
export async function recordBillingOutcome(eventId: string, fields: BillingOutcomeFields): Promise<void> {
  if (storeMode(NAME) === 'mongo') {
    await BillingEvent.updateOne({ eventId }, { $set: fields });
    return;
  }
  const set = Object.fromEntries(Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, {
      $literal: key === 'userId' ? new Types.ObjectId(String(value)) : value,
    }]));
  await billingEventStore().updateWhere({ eventId }, [{ $set: set }]);
}
