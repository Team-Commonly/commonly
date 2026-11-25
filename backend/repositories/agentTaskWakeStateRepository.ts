import AgentTaskWakeState from '../models/AgentTaskWakeState';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'AgentTaskWakeState';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('agent_task_wake_states: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for the per-seat assigned-task wake throttle, selected by
 * STORE_MODE_AGENT_TASK_WAKE_STATE. Table:
 * config/migrations/0019_agent_task_wake_states.sql. Built on first use
 * outside mongo, so mongo mode loads nothing new.
 */
export function taskWakeStateStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: AgentTaskWakeState,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'agent_task_wake_states',
      idColumn: 'id',
      columns: ['last_wake_at', 'created_at', 'updated_at'],
    }),
    toRow: (doc) => ({
      id: String(doc._id),
      last_wake_at: doc.lastWakeAt ?? null,
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: a released slot has no lastWakeAt at all.
    fromRow: (row) => ({
      _id: String(row.id),
      ...(row.last_wake_at == null ? {} : { lastWakeAt: new Date(row.last_wake_at as string) }),
      ...(row.created_at == null ? {} : { createdAt: new Date(row.created_at as string) }),
      ...(row.updated_at == null ? {} : { updatedAt: new Date(row.updated_at as string) }),
    }),
  });
  return store;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

/**
 * Takes the seat's wake slot at `now` when the seat has none, or its last wake
 * is `intervalMs` old or older, or its slot was released. True when this call
 * took it; false when another worker holds it (a wake inside the interval, or
 * a racing worker that won).
 *
 * Exactly one of any number of racing callers takes a free slot, in every
 * mode: each way to take it is one atomic Mongo write that moves the slot
 * from free to held. mongo makes the pre-step-2 upsert, whose duplicate-key
 * error is the loser. dual and pg-read take a stale or released slot with a
 * conditional update, and an absent one with an insert-if-absent; neither
 * matches a held slot. pg refuses until step 4, before any write.
 */
export async function reserveWake(key: string, now: Date, intervalMs: number): Promise<boolean> {
  const free = [{ lastWakeAt: { $lte: new Date(now.getTime() - intervalMs) } }, { lastWakeAt: null }];
  if (storeMode(NAME) === 'mongo') {
    try {
      const state = await AgentTaskWakeState.findOneAndUpdate(
        { _id: key, $or: free },
        { $set: { lastWakeAt: now } },
        { upsert: true, new: true },
      );
      return Boolean(state);
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }
  const wakeStore = taskWakeStateStore();
  // A slot that exists: stale or released. The filter runs on Mongo only.
  if (await wakeStore.updateWhere({ _id: key, $or: free }, [{ $set: { lastWakeAt: { $literal: now } } }])) {
    return true;
  }
  // A slot that does not exist yet. A slot that exists and is held matches neither.
  return (await wakeStore.insertIfAbsent({ _id: key }, { lastWakeAt: now })).inserted;
}

/**
 * Returns the slot this worker took at `now`, so the next sweep may wake the
 * seat. A slot taken again since (another `now`) is left alone. True when
 * released. The document stays; only its lastWakeAt goes.
 */
export async function releaseWake(key: string, now: Date): Promise<boolean> {
  if (storeMode(NAME) === 'mongo') {
    const result = await AgentTaskWakeState.updateOne({ _id: key, lastWakeAt: now }, { $unset: { lastWakeAt: 1 } });
    return result.modifiedCount > 0;
  }
  return taskWakeStateStore().updateWhere({ _id: key, lastWakeAt: now }, [{ $unset: 'lastWakeAt' }]);
}
