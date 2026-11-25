import { Types } from 'mongoose';
import { AgentComputerTakeover } from '../models/AgentComputerTakeover';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'AgentComputerTakeover';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('agent_computer_takeovers: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for a person's takeover of an agent's computer (keyed by the
 * AgentInstallation id, owned by one user), selected by
 * STORE_MODE_AGENT_COMPUTER_TAKEOVER. Table:
 * config/migrations/0021_agent_computer_takeovers.sql. Built on first use
 * outside mongo, so mongo mode loads nothing new.
 */
export function computerTakeoverStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: AgentComputerTakeover,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'agent_computer_takeovers',
      idColumn: 'id',
      columns: ['owner_id', 'active', 'target_id', 'created_at', 'updated_at'],
    }),
    filterColumns: {
      _id: 'id',
      ownerId: 'owner_id',
      active: 'active',
    },
    toRow: (doc) => ({
      id: String(doc._id),
      owner_id: String(doc.ownerId),
      active: Boolean(doc.active),
      target_id: doc.targetId ?? null,
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: ObjectIds, and no targetId until one is bound.
    fromRow: (row) => ({
      _id: new Types.ObjectId(String(row.id)),
      ownerId: new Types.ObjectId(String(row.owner_id)),
      active: Boolean(row.active),
      ...(row.target_id == null ? {} : { targetId: String(row.target_id) }),
      ...(row.created_at == null ? {} : { createdAt: new Date(row.created_at as string) }),
      ...(row.updated_at == null ? {} : { updatedAt: new Date(row.updated_at as string) }),
    }),
  });
  return store;
}

/**
 * The upsert `updateOne({ _id, ownerId }, { $set }, { upsert: true })` makes,
 * through the helper: update the owner's document; when there is none, insert
 * it; when a racing first write inserted it meanwhile, update again (the last
 * writer's value stands). The insert's filter carries the owner, so an
 * installation id another user owns is never matched: its insert fails on the
 * _id with a duplicate key (11000), which propagates as in mongo, and neither
 * store changes. pg refuses until step 4, before any write (updateWhere does).
 */
async function upsertOwned(
  userId: string, installationId: string, set: Record<string, unknown>, onInsert: Record<string, unknown>,
): Promise<void> {
  const takeoverStore = computerTakeoverStore();
  const owned = { _id: installationId, ownerId: userId };
  // $literal keeps a value like "$x" from being read as a field path.
  const pipeline = [{ $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [k, { $literal: v }])) }];
  if (await takeoverStore.updateWhere(owned, pipeline)) return;
  if ((await takeoverStore.insertIfAbsent(owned, { ...onInsert, ...set })).inserted) return;
  // Found on insert: the same owner's document, written by a racing first call.
  if (!await takeoverStore.updateWhere(owned, pipeline)) {
    throw new Error(`dual-store: ${NAME} write found no document after its insert lost a race`);
  }
}

/** True when `userId` owns the installation's takeover and it is active. */
export async function isTakeoverActive(userId: string, installationId: string): Promise<boolean> {
  const filter = { _id: installationId, ownerId: userId, active: true };
  if (storeMode(NAME) === 'mongo') return Boolean(await AgentComputerTakeover.exists(filter));
  return Boolean(await computerTakeoverStore().findOneWhere(filter, { fields: ['_id'] }));
}

/** Sets the owner's takeover on or off, creating the document on first use. */
export async function setTakeover(userId: string, installationId: string, active: boolean): Promise<void> {
  if (storeMode(NAME) === 'mongo') {
    await AgentComputerTakeover.updateOne(
      { _id: installationId, ownerId: userId },
      { $set: { active } },
      { upsert: true },
    );
    return;
  }
  await upsertOwned(userId, installationId, { active }, {});
}

/** The owner's installations bound to a browser target, as non-empty string targetIds. */
export async function listBindings(userId: string): Promise<{ installationId: string; targetId: string }[]> {
  const rows = storeMode(NAME) === 'mongo'
    ? await AgentComputerTakeover.find({ ownerId: userId, targetId: { $exists: true } })
      .select('_id targetId').lean()
    // The helper's filter has no $exists; the check below drops a missing targetId the same way.
    : await computerTakeoverStore().findWhere({ ownerId: userId }, { fields: ['targetId'] });
  return (rows as Array<{ _id: unknown; targetId?: unknown }>).flatMap((row) => {
    const { targetId } = row;
    return typeof targetId === 'string' && targetId
      ? [{ installationId: String(row._id), targetId }] : [];
  });
}

/** Binds the owner's installation to a browser target; a first bind starts inactive. */
export async function bindTarget(userId: string, installationId: string, targetId: string): Promise<void> {
  if (storeMode(NAME) === 'mongo') {
    await AgentComputerTakeover.updateOne(
      { _id: installationId, ownerId: userId },
      { $set: { targetId }, $setOnInsert: { active: false } },
      { upsert: true },
    );
    return;
  }
  await upsertOwned(userId, installationId, { targetId }, { active: false });
}
