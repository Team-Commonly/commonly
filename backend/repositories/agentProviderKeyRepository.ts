import { Types } from 'mongoose';
import AgentProviderKey from '../models/AgentProviderKey';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'AgentProviderKey';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('agent_provider_keys: PostgreSQL is not configured (PG_HOST)');
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
 * ADR-034 step 2 for an agent's own provider-key binding, selected by
 * STORE_MODE_AGENT_PROVIDER_KEY. Table: config/migrations/0026_agent_provider_keys.sql.
 * Built on first use outside mongo, so mongo mode loads nothing new.
 *
 * secretRef is a reference, not key material: the id of the ConnectorSecret
 * that holds the key encrypted (services/connectorSecrets.ts). No path of this
 * model is `select: false`, so every read returns the whole binding, in every
 * mode, as the pre-step-2 reads did. User ObjectIds are hex text in Postgres
 * and come back as ObjectIds, as a lean read returns them.
 */
export function providerKeyStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: AgentProviderKey,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'agent_provider_keys',
      idColumn: 'id',
      columns: ['agent_user_id', 'owner_user_id', 'provider_id', 'base_url', 'generation', 'secret_ref',
        'set_at', 'set_by', 'last_used_at', 'created_at', 'updated_at'],
    }),
    filterColumns: {
      _id: 'id', agentUserId: 'agent_user_id', ownerUserId: 'owner_user_id', secretRef: 'secret_ref',
    },
    toRow: (doc) => ({
      id: String(doc._id),
      agent_user_id: hexOrNull(doc.agentUserId),
      owner_user_id: hexOrNull(doc.ownerUserId),
      provider_id: doc.providerId ?? null,
      base_url: doc.baseURL ?? null,
      generation: doc.generation ?? null,
      secret_ref: doc.secretRef ?? null,
      set_at: doc.setAt ?? null,
      set_by: hexOrNull(doc.setBy),
      last_used_at: doc.lastUsedAt ?? null,
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: every schema default present
    // (null where unset), ObjectIds as ObjectIds.
    fromRow: (row) => ({
      _id: new Types.ObjectId(String(row.id)),
      agentUserId: objectIdOrNull(row.agent_user_id),
      ownerUserId: objectIdOrNull(row.owner_user_id),
      providerId: row.provider_id ?? null,
      baseURL: row.base_url ?? null,
      ...(row.generation == null ? {} : { generation: Number(row.generation) }),
      secretRef: row.secret_ref ?? null,
      setAt: dateOrNull(row.set_at),
      setBy: objectIdOrNull(row.set_by),
      lastUsedAt: dateOrNull(row.last_used_at),
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

export type ProviderKeyRow = {
  _id: Types.ObjectId | string; agentUserId: unknown; ownerUserId: unknown;
  providerId: string; baseURL: string; generation: number; secretRef: string | null;
  setAt: Date | null; setBy: unknown; lastUsedAt: Date | null;
};
/** The one binding of an agent to its owner: the filter every write of a binding starts from. */
export type ProviderKeyOwner = { agentUserId: unknown; ownerUserId: unknown };

const ownerFilter = ({ agentUserId, ownerUserId }: ProviderKeyOwner): Doc => ({ agentUserId, ownerUserId });

/**
 * The agent's binding for this owner, or null. mongo makes the pre-step-2
 * `findOne(filter)` (lean). dual reads Mongo; pg-read and pg read Postgres
 * (pg-read reads Mongo while any document is flagged). A stale Postgres read
 * can only make a later lock lose: every write below is decided on Mongo.
 */
export async function findProviderKey(owner: ProviderKeyOwner): Promise<ProviderKeyRow | null> {
  if (storeMode(NAME) === 'mongo') {
    return AgentProviderKey.findOne(ownerFilter(owner)).lean() as unknown as Promise<ProviderKeyRow | null>;
  }
  return providerKeyStore().findOneWhere(ownerFilter(owner)) as unknown as Promise<ProviderKeyRow | null>;
}

/**
 * Whether a binding still names `secretRef`, for the orphaned-secret sweep:
 * `{ _id, secretRef }` or null. mongo makes the pre-step-2
 * `findOne({ secretRef }).select('secretRef').lean()`.
 *
 * It reads Mongo in mongo, dual and pg-read, and Postgres only in pg. The
 * sweep revokes the secret when this answers null, so a Postgres row that
 * lags a set (a copy another process has not repaired yet, which this
 * process's 5-second flag cache cannot see) would delete a live key.
 */
export async function findProviderKeyBySecretRef(
  secretRef: string,
): Promise<{ _id: unknown; secretRef: string } | null> {
  const mode = storeMode(NAME);
  if (mode === 'mongo') {
    return AgentProviderKey.findOne({ secretRef }).select('secretRef').lean() as unknown as Promise<
      { _id: unknown; secretRef: string } | null>;
  }
  const found = mode === 'pg'
    ? await providerKeyStore().findOneWhere({ secretRef }, { fields: ['secretRef'] })
    : (await providerKeyStore().findPageMongo({ secretRef }, { limit: 1, fields: ['secretRef'] }))[0] ?? null;
  return found as { _id: unknown; secretRef: string } | null;
}

/**
 * The remove: bumps the generation and clears the key's fields, atomically,
 * returning the binding as it was (null when there is none), so the caller
 * deletes exactly the secret this generation named. Never inserts.
 *
 * mongo makes the pre-step-2 `findOneAndUpdate(filter, { $inc, $set }, { new: false })`.
 * dual and pg-read make the helper's `findOneAndUpdateWhere` with
 * `returnDocument: 'before'`, decided on Mongo. pg refuses until step 4,
 * before any write.
 */
export async function clearProviderKey(owner: ProviderKeyOwner): Promise<ProviderKeyRow | null> {
  refuseInPg('clearProviderKey');
  const update = {
    $inc: { generation: 1 }, $set: { secretRef: null, setAt: null, setBy: null, lastUsedAt: null },
  };
  if (storeMode(NAME) === 'mongo') {
    return AgentProviderKey.findOneAndUpdate(ownerFilter(owner), update, { new: false })
      .lean() as unknown as Promise<ProviderKeyRow | null>;
  }
  return providerKeyStore().findOneAndUpdateWhere(ownerFilter(owner), update, { returnDocument: 'before' }) as
    unknown as Promise<ProviderKeyRow | null>;
}

/**
 * The start of a set: bumps the generation, creating the binding with this
 * destination when it is absent, and returns it as it is now. The returned
 * generation is the lock `commitProviderKey` must still find.
 *
 * mongo makes the pre-step-2 `$inc` + `$setOnInsert` upsert (`new: true`,
 * `setDefaultsOnInsert`). dual and pg-read make the helper's
 * `findOneAndUpdateWhere` upsert with `returnDocument: 'after'`: the `$inc` is
 * computed on Mongo and the whole document copied, so no increment is lost to
 * a race. pg refuses until step 4, before any write.
 */
export async function bumpProviderKeyGeneration(
  owner: ProviderKeyOwner, destination: { providerId: string; baseURL: string },
): Promise<ProviderKeyRow> {
  refuseInPg('bumpProviderKeyGeneration');
  const update = {
    $inc: { generation: 1 }, $setOnInsert: { providerId: destination.providerId, baseURL: destination.baseURL },
  };
  if (storeMode(NAME) === 'mongo') {
    return AgentProviderKey.findOneAndUpdate(ownerFilter(owner), update, {
      upsert: true, new: true, setDefaultsOnInsert: true,
    }).lean() as unknown as Promise<ProviderKeyRow>;
  }
  return providerKeyStore().findOneAndUpdateWhere(ownerFilter(owner), update, {
    returnDocument: 'after', upsert: true,
  }) as unknown as Promise<ProviderKeyRow>;
}

export type ProviderKeyCommit = {
  secretRef: string; providerId: string; baseURL: string; setAt: Date; setBy: unknown; lastUsedAt: null;
};

/**
 * The end of a set: writes the new secret and destination only while the
 * binding is still at `generation`, returning it as it is now, or null when a
 * remove or a newer set moved it on (the caller then revokes its secret).
 *
 * mongo makes the pre-step-2 `findOneAndUpdate({ ...filter, generation }, { $set }, { new: true })`.
 * dual and pg-read make the helper's `findOneAndUpdateWhere` on the same
 * filter with `returnDocument: 'after'`; the generation is matched on Mongo.
 * pg refuses until step 4, before any write.
 */
export async function commitProviderKey(
  owner: ProviderKeyOwner, generation: number, fields: ProviderKeyCommit,
): Promise<ProviderKeyRow | null> {
  refuseInPg('commitProviderKey');
  const filter = { ...ownerFilter(owner), generation };
  if (storeMode(NAME) === 'mongo') {
    return AgentProviderKey.findOneAndUpdate(filter, { $set: fields }, { new: true })
      .lean() as unknown as Promise<ProviderKeyRow | null>;
  }
  return providerKeyStore().findOneAndUpdateWhere(filter, { $set: fields }, { returnDocument: 'after' }) as
    unknown as Promise<ProviderKeyRow | null>;
}

/**
 * Stamps lastUsedAt on the binding only while it still names the same secret
 * at the same generation. True when it matched; false means the key changed
 * since it was read, and the caller must not hand the material out.
 *
 * mongo makes the pre-step-2 `updateOne` and answers `matchedCount > 0`. dual
 * and pg-read make the helper's `setWhere` on the same filter, on Mongo, true
 * when a document matched. pg refuses until step 4 (setWhere does).
 */
export async function markProviderKeyUsed(
  row: Pick<ProviderKeyRow, '_id' | 'secretRef' | 'generation'>, at: Date,
): Promise<boolean> {
  const filter = { _id: row._id, secretRef: row.secretRef, generation: row.generation };
  if (storeMode(NAME) === 'mongo') {
    return (await AgentProviderKey.updateOne(filter, { $set: { lastUsedAt: at } })).matchedCount > 0;
  }
  return providerKeyStore().setWhere(filter, { lastUsedAt: at });
}
