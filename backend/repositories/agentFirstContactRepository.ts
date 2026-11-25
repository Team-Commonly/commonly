import { Types } from 'mongoose';
import AgentFirstContact from '../models/AgentFirstContact';
import {
  createDualStore, pgTableAdapter, storeMode, type DualStore,
} from './dualStore';

type Doc = Record<string, unknown>;

/** The relationship a marker records, matched by the model's unique index. */
export type FirstContactIdentity = {
  userId: Types.ObjectId;
  agentName: string;
  instanceId: string;
};

/** findOneAndUpdate with includeResultMetadata: the driver's raw result. */
type RawResult = { value?: unknown; lastErrorObject?: { updatedExisting?: boolean } } | null;

const NAME = 'AgentFirstContact';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('agent_first_contacts: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

/** A Mongoose Map, or the plain object a lean read gives, as a plain object. */
const greetings = (value: unknown): Record<string, unknown> => {
  if (value instanceof Map) return Object.fromEntries(value);
  return value && typeof value === 'object' ? { ...(value as Doc) } : {};
};

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for the first-contact marker, selected by
 * STORE_MODE_AGENT_FIRST_CONTACT. Table: config/migrations/0017_agent_first_contacts.sql.
 * Built on first use outside mongo, so mongo mode loads nothing new.
 */
export function firstContactStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: AgentFirstContact,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'agent_first_contacts',
      idColumn: 'id',
      columns: ['user_id', 'agent_name', 'instance_id', 'first_pod_id', 'greeted_at_by_pod', 'created_at'],
      jsonColumns: ['greeted_at_by_pod'],
    }),
    toRow: (doc) => ({
      id: String(doc._id),
      user_id: String(doc.userId),
      agent_name: doc.agentName,
      instance_id: doc.instanceId,
      first_pod_id: String(doc.firstPodId),
      greeted_at_by_pod: greetings(doc.greetedAtByPod),
      created_at: doc.createdAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: ObjectIds, Dates, the map as an object.
    fromRow: (row) => ({
      _id: new Types.ObjectId(String(row.id)),
      userId: new Types.ObjectId(String(row.user_id)),
      agentName: row.agent_name,
      instanceId: row.instance_id,
      firstPodId: new Types.ObjectId(String(row.first_pod_id)),
      greetedAtByPod: Object.fromEntries(Object.entries(greetings(row.greeted_at_by_pod))
        .map(([podId, at]) => [podId, new Date(at as string)])),
      ...(row.created_at == null ? {} : { createdAt: new Date(row.created_at as string) }),
    }),
  });
  return store;
}

/**
 * The first claim: creates the marker unless this relationship already has
 * one. `inserted` is true only for the call that created it. A duplicate-key
 * error (two first claims racing past the unique index) propagates as before;
 * the caller reads it as a lost race. Mongo mode is the pre-step-2 write,
 * unchanged; the store's insertIfAbsent is the same claim plus the copy.
 */
export async function claimFirstContact(
  identity: FirstContactIdentity,
  fields: { firstPodId: Types.ObjectId; greetedAtByPod?: Record<string, Date>; createdAt: Date },
): Promise<{ inserted: boolean }> {
  const created = { ...identity, ...fields };
  if (storeMode(NAME) !== 'mongo') return firstContactStore().insertIfAbsent(identity, created);
  const result = await AgentFirstContact.findOneAndUpdate(
    identity,
    { $setOnInsert: created },
    {
      upsert: true,
      new: false,
      // Mongoose 7 replacement for deprecated rawResult: true. We need the
      // driver's updatedExisting flag to distinguish the winning insert.
      includeResultMetadata: true,
      setDefaultsOnInsert: true,
    },
  ) as unknown as RawResult;
  return { inserted: !(result?.lastErrorObject?.updatedExisting === true || result?.value != null) };
}

/**
 * The greeting claim: stamps `greetedAtByPod.<podId>` with `now` only if this
 * relationship has no stamp for the pod or one older than `expiredBefore`.
 * True only for the call that stamped it.
 */
export async function claimPodGreeting(
  identity: FirstContactIdentity, podId: Types.ObjectId, now: Date, expiredBefore: Date,
): Promise<boolean> {
  const path = `greetedAtByPod.${String(podId)}`;
  const filter = {
    ...identity,
    $or: [
      { [path]: { $exists: false } },
      { [path]: { $lt: expiredBefore } },
    ],
  };
  if (storeMode(NAME) !== 'mongo') return firstContactStore().setWhere(filter, { [path]: now });
  const claim = await AgentFirstContact.findOneAndUpdate(
    filter,
    { $set: { [path]: now } },
    { new: false, includeResultMetadata: true },
  ) as unknown as RawResult;
  return claim?.value != null;
}
