import { Types } from 'mongoose';
import HostedMcpDcrRegistration from '../models/HostedMcpDcrRegistration';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'HostedMcpDcrRegistration';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('hosted_mcp_dcr_registrations: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

type Doc = Record<string, unknown>;

const dateOrNull = (value: unknown): Date | null => (value == null ? null : new Date(value as string));

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for the instance's hosted-MCP DCR clients, selected by
 * STORE_MODE_HOSTED_MCP_DCR_REGISTRATION. Table:
 * config/migrations/0027_hosted_mcp_dcr_registrations.sql. Built on first use
 * outside mongo, so mongo mode loads nothing new.
 *
 * clientSecretRef is a reference, not a secret: the id of the ConnectorSecret
 * that holds a confidential client's secret encrypted (services/connectorSecrets.ts).
 * No registration_access_token is stored, and no path of this model is
 * `select: false`, so every read returns the whole registration in every mode.
 */
export function dcrRegistrationStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: HostedMcpDcrRegistration,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'hosted_mcp_dcr_registrations',
      idColumn: 'id',
      columns: ['entry_id', 'issuer', 'client_id', 'redirect_uri', 'token_endpoint_auth_method',
        'client_secret_ref', 'client_secret_expires_at', 'current', 'retired_at', 'refused_at', 'asked_at',
        'created_at', 'updated_at'],
    }),
    // Only pg mode filters Postgres: dual and pg-read read every registration from Mongo (see below).
    filterColumns: {
      _id: 'id', entryId: 'entry_id', issuer: 'issuer', clientId: 'client_id', current: 'current',
      refusedAt: 'refused_at',
    },
    toRow: (doc) => ({
      id: String(doc._id),
      entry_id: doc.entryId ?? null,
      issuer: doc.issuer ?? null,
      client_id: doc.clientId ?? null,
      redirect_uri: doc.redirectUri ?? null,
      token_endpoint_auth_method: doc.tokenEndpointAuthMethod ?? null,
      client_secret_ref: doc.clientSecretRef ?? null,
      client_secret_expires_at: doc.clientSecretExpiresAt ?? null,
      current: doc.current ?? null,
      retired_at: doc.retiredAt ?? null,
      refused_at: doc.refusedAt ?? null,
      asked_at: doc.askedAt ?? null,
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: every schema default present
    // (null where unset).
    fromRow: (row) => ({
      _id: new Types.ObjectId(String(row.id)),
      entryId: row.entry_id ?? null,
      issuer: row.issuer ?? null,
      clientId: row.client_id ?? null,
      redirectUri: row.redirect_uri ?? null,
      tokenEndpointAuthMethod: row.token_endpoint_auth_method ?? 'none',
      clientSecretRef: row.client_secret_ref ?? null,
      clientSecretExpiresAt: dateOrNull(row.client_secret_expires_at),
      ...(row.current == null ? {} : { current: Boolean(row.current) }),
      retiredAt: dateOrNull(row.retired_at),
      refusedAt: dateOrNull(row.refused_at),
      askedAt: dateOrNull(row.asked_at),
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

/**
 * Throws in pg mode, for a caller about to do work that must end in a write
 * here (ensureDcrClient's vendor registration and secret store come before its
 * claim), so pg refuses before anything is written anywhere.
 */
export const assertDcrRegistrationWritable = (operation: string): void => refuseInPg(operation);

export type DcrRegistrationRow = {
  _id: Types.ObjectId; entryId: string; issuer: string; clientId: string; redirectUri: string;
  tokenEndpointAuthMethod?: 'none' | 'client_secret_basic' | 'client_secret_post';
  clientSecretRef?: string | null; clientSecretExpiresAt?: Date | null; current: boolean;
  retiredAt?: Date | null; refusedAt?: Date | null; askedAt?: Date | null; createdAt: Date; updatedAt: Date;
};
/** The catalogue entry and issuer a registration belongs to. */
export type DcrEntryKey = { id: string; issuer: string };

const currentFilter = (entry: DcrEntryKey): Doc => ({ entryId: entry.id, issuer: entry.issuer, current: true });

/**
 * mongo mode makes each pre-step-2 Mongoose call exactly, hydrated documents
 * included; dual, pg-read and pg return the plain lean shape. Callers read
 * fields only, so both serve them.
 *
 * Every read here feeds a security decision: whether a client may be handed to
 * a new start, whether a row may still use its client, whether a secret is
 * still owned. A Postgres row that lags a refusal or a retirement (a copy that
 * failed in another process, unseen by this one's 5-second flag cache) could
 * admit a refused client, so every read stays on Mongo in mongo, dual and
 * pg-read (findPageMongo, the system of record there) and reads Postgres only
 * in pg, where it is the only store.
 */
const readOne = async (
  filter: Doc, mongo: () => Promise<unknown>, fields?: string[],
): Promise<DcrRegistrationRow | null> => {
  const mode = storeMode(NAME);
  if (mode === 'mongo') return mongo() as Promise<DcrRegistrationRow | null>;
  if (mode === 'pg') {
    return dcrRegistrationStore().findOneWhere(filter, fields ? { fields } : {}) as unknown as
      Promise<DcrRegistrationRow | null>;
  }
  const [found] = await dcrRegistrationStore().findPageMongo(filter, { limit: 1, ...(fields ? { fields } : {}) });
  return (found ?? null) as DcrRegistrationRow | null;
};

/**
 * Builds the unique indexes the claim relies on, before a first start's
 * upsert (Mongoose builds them in the background). Mongo decides the claim in
 * every mode but pg, which never writes Mongo, so pg skips it.
 */
export async function initDcrRegistrations(): Promise<void> {
  if (storeMode(NAME) === 'pg') return;
  await HostedMcpDcrRegistration.init();
}

/**
 * The entry's current client, or null. mongo makes the pre-step-2
 * `findOne({ entryId, issuer, current: true })` (a hydrated document). Mongo in dual and
 * pg-read, Postgres in pg.
 */
export async function findCurrentDcrRegistration(entry: DcrEntryKey): Promise<DcrRegistrationRow | null> {
  const filter = currentFilter(entry);
  return readOne(filter, () => HostedMcpDcrRegistration.findOne(filter));
}

/**
 * The registration of `clientId` unless the vendor refused it: what a
 * connection row may still use. mongo makes the pre-step-2 `findOne` (with
 * `refusedAt: null`). Mongo in dual and pg-read, Postgres in pg.
 */
export async function findUsableDcrRegistration(
  entry: DcrEntryKey, clientId: string,
): Promise<DcrRegistrationRow | null> {
  const filter = {
    entryId: entry.id, issuer: entry.issuer, clientId, refusedAt: null,
  };
  return readOne(filter, () => HostedMcpDcrRegistration.findOne(filter));
}

/**
 * `{ _id, refusedAt, clientSecretRef }` of a registration, for the
 * orphaned-secret sweep, which revokes the secret when this is null, refused,
 * or names another. mongo makes the pre-step-2
 * `findById(id).select('refusedAt clientSecretRef').lean()`. Mongo in dual
 * and pg-read: a lagging Postgres row must never make a live secret look
 * unowned. Postgres in pg.
 */
export async function findDcrRegistrationSecretOwner(id: unknown): Promise<Doc | null> {
  return readOne(
    { _id: id },
    () => HostedMcpDcrRegistration.findById(id).select('refusedAt clientSecretRef').lean(),
    ['refusedAt', 'clientSecretRef'],
  ) as Promise<Doc | null>;
}

const PAGE = 500;

/**
 * Every current client, by entryId, for the admin script. mongo makes the
 * pre-step-2 `find({ current: true }).sort({ entryId: 1 }).lean()`. dual and
 * pg-read page it from Mongo; pg reads Postgres and sorts in JS (entryId,
 * then _id, as the Mongo pages tie-break).
 */
export async function listCurrentDcrRegistrations(): Promise<DcrRegistrationRow[]> {
  const mode = storeMode(NAME);
  if (mode === 'mongo') {
    return HostedMcpDcrRegistration.find({ current: true }).sort({ entryId: 1 }).lean() as unknown as
      Promise<DcrRegistrationRow[]>;
  }
  if (mode === 'pg') {
    const rows = await dcrRegistrationStore().findWhere({ current: true }) as unknown as DcrRegistrationRow[];
    return rows.sort((a, b) => (a.entryId === b.entryId
      ? String(a._id).localeCompare(String(b._id)) : (a.entryId < b.entryId ? -1 : 1)));
  }
  const all: DcrRegistrationRow[] = [];
  for (let skip = 0; ; skip += PAGE) {
    // eslint-disable-next-line no-await-in-loop -- pages in order
    const page = await dcrRegistrationStore().findPageMongo({ current: true }, {
      sort: { entryId: 1 }, skip, limit: PAGE,
    }) as unknown as DcrRegistrationRow[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

export type DcrRegistrationInsert = {
  _id: Types.ObjectId; clientId: string; redirectUri: string;
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  clientSecretRef: string | null; clientSecretExpiresAt: Date | null;
};

/**
 * Makes `fields` the entry's current client unless one already is, returning
 * the current client as it is now: this call's (its `_id`) when it won, the
 * other's when it lost. The unique `{ entryId, issuer }` index on
 * `current: true` admits exactly one winner.
 *
 * mongo makes the pre-step-2 `$setOnInsert` upsert (`new: true`,
 * `setDefaultsOnInsert`); a loser of the insert race may throw
 * code 11000 there, which the caller handles. dual and pg-read make the
 * helper's `findOneAndUpdateWhere` upsert of `$setOnInsert` alone with
 * `returnDocument: 'after'`, decided on Mongo: a loser goes round once and
 * reads the winner, so it returns the winner instead of throwing. pg refuses
 * until step 4, before any write.
 */
export async function claimCurrentDcrRegistration(
  entry: DcrEntryKey, fields: DcrRegistrationInsert,
): Promise<DcrRegistrationRow | null> {
  refuseInPg('claimCurrentDcrRegistration');
  const filter = currentFilter(entry);
  const update = {
    $setOnInsert: {
      ...fields, entryId: entry.id, issuer: entry.issuer, current: true,
    },
  };
  if (storeMode(NAME) === 'mongo') {
    return HostedMcpDcrRegistration.findOneAndUpdate(filter, update, {
      upsert: true, new: true, setDefaultsOnInsert: true,
    }) as unknown as Promise<DcrRegistrationRow | null>;
  }
  return dcrRegistrationStore().findOneAndUpdateWhere(filter, update, {
    returnDocument: 'after', upsert: true,
  }) as unknown as Promise<DcrRegistrationRow | null>;
}

/**
 * Retires one registration by id while it is still current. mongo makes the
 * pre-step-2 `updateOne({ _id, current: true }, { $set })`; dual and pg-read
 * the helper's `setWhere` on the same filter, on Mongo. pg refuses until
 * step 4 (setWhere does), before any write.
 */
export async function retireDcrRegistrationById(id: unknown, now: Date): Promise<void> {
  const filter = { _id: id, current: true };
  const fields = { current: false, retiredAt: now };
  if (storeMode(NAME) === 'mongo') {
    await HostedMcpDcrRegistration.updateOne(filter, { $set: fields });
    return;
  }
  await dcrRegistrationStore().setWhere(filter, fields);
}

/**
 * Retires the entry's current client (only while it is `clientId`, when
 * given). True when a client was retired. mongo makes the pre-step-2
 * `updateOne` and answers `modifiedCount > 0`; dual and pg-read make the
 * helper's `setWhere` on the same filter, on Mongo, true when a document
 * matched (the filter's `current: true` is what it sets false, so a match is
 * a change). pg refuses until step 4, before any write.
 */
export async function retireCurrentDcrRegistration(
  entry: DcrEntryKey, clientId: string | undefined, now: Date,
): Promise<boolean> {
  const filter = clientId ? { ...currentFilter(entry), clientId } : currentFilter(entry);
  const fields = { current: false, retiredAt: now };
  if (storeMode(NAME) === 'mongo') {
    const write = await HostedMcpDcrRegistration.updateOne(filter, { $set: fields });
    return (write.modifiedCount ?? 0) > 0;
  }
  return dcrRegistrationStore().setWhere(filter, fields);
}

/**
 * Marks `clientId` refused (and retired) once, returning the registration as
 * it was, or null when it is absent or already refused: exactly one caller
 * gets the pre-image, and so deletes the secret it names.
 *
 * mongo makes the pre-step-2 `findOneAndUpdate(filter, { $set })` (Mongoose's
 * default `new: false`). dual and pg-read make the helper's
 * `findOneAndUpdateWhere` with `returnDocument: 'before'`, decided on Mongo.
 * pg refuses until step 4, before any write.
 */
export async function refuseDcrRegistration(
  entry: DcrEntryKey, clientId: string, now: Date,
): Promise<DcrRegistrationRow | null> {
  refuseInPg('refuseDcrRegistration');
  const filter = {
    entryId: entry.id, issuer: entry.issuer, clientId, refusedAt: null,
  };
  const update = { $set: { refusedAt: now, retiredAt: now, current: false } };
  if (storeMode(NAME) === 'mongo') {
    return HostedMcpDcrRegistration.findOneAndUpdate(filter, update) as unknown as
      Promise<DcrRegistrationRow | null>;
  }
  return dcrRegistrationStore().findOneAndUpdateWhere(filter, update, { returnDocument: 'before' }) as unknown as
    Promise<DcrRegistrationRow | null>;
}

/**
 * Claims the right to ask the vendor about the entry's current `clientId`:
 * stamps `askedAt` only while the client is current, unrefused, older than
 * `intervalMs`, and not asked within it, returning it as it is now, or null.
 * Exactly one caller per interval gets it.
 *
 * mongo makes the pre-step-2 `findOneAndUpdate` under `$or` and the ranges
 * (`new: true`). dual and pg-read make the helper's
 * `findOneAndUpdateWhere` on the same filter with `returnDocument: 'after'`,
 * decided on Mongo. pg refuses until step 4, before any write.
 */
export async function claimDcrAsk(
  entry: DcrEntryKey, clientId: string, now: Date, intervalMs: number,
): Promise<DcrRegistrationRow | null> {
  refuseInPg('claimDcrAsk');
  const since = new Date(now.getTime() - intervalMs);
  const filter = {
    ...currentFilter(entry),
    clientId,
    refusedAt: null,
    createdAt: { $lte: since },
    $or: [{ askedAt: null }, { askedAt: { $lte: since } }],
  };
  const update = { $set: { askedAt: now } };
  if (storeMode(NAME) === 'mongo') {
    return HostedMcpDcrRegistration.findOneAndUpdate(filter, update, { new: true }) as unknown as
      Promise<DcrRegistrationRow | null>;
  }
  return dcrRegistrationStore().findOneAndUpdateWhere(filter, update, { returnDocument: 'after' }) as unknown as
    Promise<DcrRegistrationRow | null>;
}
