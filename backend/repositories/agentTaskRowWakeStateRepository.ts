import { Types } from 'mongoose';
import AgentTaskRowWakeState from '../models/AgentTaskRowWakeState';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'AgentTaskRowWakeState';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('agent_task_row_wake_states: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

type Doc = Record<string, unknown>;

const dateOrNull = (value: unknown): Date | null => (value == null ? null : new Date(value as string));
const hexOrNull = (value: unknown): string | null => (value == null ? null : String(value));
const objectIdOrNull = (value: unknown): Types.ObjectId | null => (
  value == null ? null : new Types.ObjectId(String(value)));

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for the per-row assigned-task wake state, selected by
 * STORE_MODE_AGENT_TASK_ROW_WAKE_STATE. Table:
 * config/migrations/0025_agent_task_row_wake_states.sql. Built on first use
 * outside mongo, so mongo mode loads nothing new.
 *
 * lastWakeEventId and countedEventId are ObjectIds in Mongo and hex text in
 * Postgres; a Postgres read hands them back as ObjectIds, as a lean read does.
 */
export function rowWakeStateStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: AgentTaskRowWakeState,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'agent_task_row_wake_states',
      idColumn: 'id',
      columns: ['last_wake_at', 'last_wake_event_id', 'counted_event_id', 'failures', 'stopped_at',
        'last_verdict', 'created_at', 'updated_at'],
    }),
    filterColumns: { _id: 'id' },
    toRow: (doc) => ({
      id: String(doc._id),
      last_wake_at: doc.lastWakeAt ?? null,
      last_wake_event_id: hexOrNull(doc.lastWakeEventId),
      counted_event_id: hexOrNull(doc.countedEventId),
      failures: doc.failures ?? null,
      stopped_at: doc.stoppedAt ?? null,
      last_verdict: doc.lastVerdict ?? null,
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: every schema default present
    // (null where unset), ObjectIds as ObjectIds.
    fromRow: (row) => ({
      _id: String(row.id),
      lastWakeAt: dateOrNull(row.last_wake_at),
      lastWakeEventId: objectIdOrNull(row.last_wake_event_id),
      countedEventId: objectIdOrNull(row.counted_event_id),
      ...(row.failures == null ? {} : { failures: Number(row.failures) }),
      stoppedAt: dateOrNull(row.stopped_at),
      lastVerdict: row.last_verdict ?? null,
      ...(row.created_at == null ? {} : { createdAt: dateOrNull(row.created_at) }),
      ...(row.updated_at == null ? {} : { updatedAt: dateOrNull(row.updated_at) }),
    }),
  });
  return store;
}

const refuseInPg = (operation: string): void => {
  if (storeMode(NAME) === 'pg') {
    throw new Error(`dual-store: ${NAME} ${operation} is not supported in pg mode until step 4`
      + ' (docs/runbooks/adr-034-model-move.md)');
  }
};

export type RowWakeState = {
  _id: string; lastWakeAt?: Date | null; lastWakeEventId?: unknown; countedEventId?: unknown;
  failures?: number; stoppedAt?: Date | null; lastVerdict?: string | null;
};

/**
 * The states of the given row keys that exist, in the plain shape a lean read
 * returns. mongo makes the pre-step-2 `find({ _id: { $in } }).lean()`. dual
 * reads Mongo; pg-read and pg read Postgres (pg-read reads Mongo while any
 * document is flagged). An empty list reads nothing.
 */
export async function findRowWakeStates(keys: string[]): Promise<RowWakeState[]> {
  if (storeMode(NAME) === 'mongo') {
    return AgentTaskRowWakeState.find({ _id: { $in: keys } }).lean() as unknown as Promise<RowWakeState[]>;
  }
  // The Postgres filter refuses an empty $in; Mongo's answer to one is no rows.
  if (!keys.length) return [];
  return rowWakeStateStore().findWhere({ _id: { $in: keys } }) as unknown as Promise<RowWakeState[]>;
}

/**
 * The one conditional change of a row's state: true when the document
 * matched `filter` and changed, which is when Mongo's `modifiedCount` is 1.
 * Every caller sets a value its filter excludes (and the timestamps move
 * updatedAt), so a match always changes the document, and `updateWhere`'s
 * matched answer is the same answer. pg refuses until step 4 (updateWhere does).
 */
async function changeWhere(filter: Doc, fields: Doc): Promise<boolean> {
  if (storeMode(NAME) === 'mongo') {
    const result = await AgentTaskRowWakeState.updateOne(filter, { $set: fields });
    return result.modifiedCount > 0;
  }
  const literal = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { $literal: value }]));
  return rowWakeStateStore().updateWhere(filter, [{ $set: literal }]);
}

export type RowOutcome = { countedEventId: unknown; failures: number; lastVerdict: string };

/**
 * Counts one run's outcome on the row, once: only while the row's
 * countedEventId is still `priorCountedEventId` (null matches a missing or
 * null field, as in Mongo). False when another scheduler counted it first.
 */
export async function countRowOutcome(
  key: string, priorCountedEventId: unknown, outcome: RowOutcome,
): Promise<boolean> {
  return changeWhere(
    { _id: key, countedEventId: priorCountedEventId ?? null },
    {
      countedEventId: objectIdOrNull(outcome.countedEventId),
      failures: outcome.failures,
      lastVerdict: outcome.lastVerdict,
    },
  );
}

/** Stops the row at `now` unless it is already stopped. True when this call stopped it. */
export async function stopRowWake(key: string, now: Date): Promise<boolean> {
  return changeWhere({ _id: key, stoppedAt: null }, { stoppedAt: now });
}

/** Undoes the stop taken at `now`, if it is still that stop. True when undone. */
export async function unstopRowWake(key: string, now: Date): Promise<boolean> {
  return changeWhere({ _id: key, stoppedAt: now }, { stoppedAt: null });
}

/** Clears the row's failure count and stop. Never inserts; true when the row existed. */
export async function resetRowWake(key: string): Promise<boolean> {
  return changeWhere({ _id: key }, { failures: 0, stoppedAt: null });
}

export type RowWakeStamp = { lastWakeAt?: Date | null; lastWakeEventId?: unknown };

// The schema's defaults, which a first write gets and a later one leaves alone.
const INSERT_DEFAULTS: Doc = {
  lastWakeAt: null, lastWakeEventId: null, countedEventId: null, failures: 0, stoppedAt: null, lastVerdict: null,
};

/**
 * Sets `stamp` on each row key, creating the state where it is absent, in
 * key order, stopping at the first failure and throwing it.
 *
 * mongo makes the pre-step-2 ordered `bulkWrite` of `updateOne` upserts.
 * dual and pg-read make one helper `upsert` per key: each is one atomic Mongo
 * write with its own version, marker and copy. pg refuses until step 4,
 * before any write.
 *
 * A partial failure leaves the keys before the failing one stamped, in every
 * mode that writes: an ordered bulkWrite stops at its failing operation, and
 * the loop stops at its failing upsert. `clearRowWakeStamps` is the
 * compensation. In dual and pg-read only a Mongo failure is a failure: a
 * Postgres copy that fails after its Mongo write leaves the marker for
 * `repair` and resolves.
 */
export async function recordRowWakes(keys: string[], stamp: RowWakeStamp): Promise<void> {
  refuseInPg('recordRowWakes');
  if (storeMode(NAME) === 'mongo') {
    await AgentTaskRowWakeState.bulkWrite(keys.map((key) => ({
      updateOne: { filter: { _id: key }, update: { $set: stamp }, upsert: true },
    })));
    return;
  }
  const fields: Doc = { ...stamp };
  if ('lastWakeEventId' in fields) fields.lastWakeEventId = objectIdOrNull(fields.lastWakeEventId);
  const wakeStore = rowWakeStateStore();
  for (const key of keys) {
    const at = new Date();
    // A first write starts from `{ _id }` alone and has no createdAt; it gets
    // the schema's defaults and its createdAt, as the bulkWrite's upsert does
    // (setDefaultsOnInsert and the timestamps' $setOnInsert). Mongoose adds
    // updatedAt to the pipeline itself.
    const isNew = { $eq: [{ $type: '$createdAt' }, 'missing'] };
    const defaults = Object.fromEntries(Object.entries(INSERT_DEFAULTS)
      .filter(([field]) => !(field in fields))
      .map(([field, value]) => [field, { $cond: [isNew, { $literal: value }, `$${field}`] }]));
    const literal = Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { $literal: value }]));
    // __v too, which the bulkWrite's upsert sets on insert; Postgres has no column for it.
    const inserted = {
      createdAt: { $cond: [isNew, { $literal: at }, '$createdAt'] }, __v: { $cond: [isNew, 0, '$__v'] },
    };
    // eslint-disable-next-line no-await-in-loop -- ordered, as the bulkWrite is: stop at the first failure
    await wakeStore.upsert(key, {
      pipeline: [{ $set: { ...defaults, ...literal, ...inserted } }],
      merge: (current) => (current
        ? { ...current, ...fields, updatedAt: at }
        : { ...INSERT_DEFAULTS, ...fields, createdAt: at, updatedAt: at }),
    });
  }
}

/**
 * The compensation for a failed `recordRowWakes(keys, { lastWakeAt: now })`:
 * clears lastWakeAt on each of `keys` still stamped at `now`, so a row the
 * failed write reached is not taken for woken. The number cleared.
 *
 * mongo makes the pre-step-2 `updateMany`. dual and pg-read make the helper's
 * `updateManyWhere` on the same filter, so each row still at `now` takes its
 * own version, marker and copy, and its cleared state reaches Postgres above
 * the stamp's version. pg refuses until step 4 (updateManyWhere does); in pg
 * `recordRowWakes` has refused before any write, so there is nothing to clear.
 * An empty list clears nothing and makes no call.
 */
export async function clearRowWakeStamps(keys: string[], now: Date): Promise<number> {
  if (!keys.length) return 0;
  const filter = { _id: { $in: keys }, lastWakeAt: now };
  if (storeMode(NAME) === 'mongo') {
    const result = await AgentTaskRowWakeState.updateMany(filter, { $set: { lastWakeAt: null } });
    return result.modifiedCount;
  }
  return rowWakeStateStore().updateManyWhere(filter, [{ $set: { lastWakeAt: { $literal: null } } }]);
}
