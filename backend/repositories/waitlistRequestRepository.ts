import { Types } from 'mongoose';
import WaitlistRequest, { type WaitlistStatus } from '../models/WaitlistRequest';
import InvitationCode from '../models/InvitationCode';
import User from '../models/User';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'WaitlistRequest';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('waitlist_requests: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

type Doc = Record<string, unknown>;

const dateOrNull = (value: unknown): Date | null => (value == null ? null : new Date(value as string));
const idOrNull = (value: unknown): Types.ObjectId | null => (value == null ? null : new Types.ObjectId(String(value)));
const hexOrNull = (value: unknown): string | null => (value == null ? null : String(value));

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for waitlist requests, selected by STORE_MODE_WAITLIST_REQUEST.
 * Table: config/migrations/0028_waitlist_requests.sql. Built on first use
 * outside mongo, so mongo mode loads nothing new.
 *
 * email, name, organization, useCase and note are what the person typed into
 * the form: personal data, copied to Postgres as Mongo holds it.
 * invitationCode is a reference, not a code: the id of the InvitationCode
 * document the admin sent (that model holds the code, and has not moved).
 * No path of this model is `select: false`.
 */
export function waitlistRequestStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: WaitlistRequest,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'waitlist_requests',
      idColumn: 'id',
      columns: ['email', 'name', 'organization', 'use_case', 'note', 'status', 'invitation_code', 'invited_at',
        'invitation_sent_at', 'invited_by', 'created_at', 'updated_at'],
    }),
    // Only pg mode filters Postgres: the pending lookup (see findPendingWaitlistRequest).
    filterColumns: { _id: 'id', email: 'email', status: 'status' },
    toRow: (doc) => ({
      id: String(doc._id),
      email: doc.email ?? null,
      name: doc.name ?? null,
      organization: doc.organization ?? null,
      use_case: doc.useCase ?? null,
      note: doc.note ?? null,
      status: doc.status ?? null,
      invitation_code: hexOrNull(doc.invitationCode),
      invited_at: doc.invitedAt ?? null,
      invitation_sent_at: doc.invitationSentAt ?? null,
      invited_by: hexOrNull(doc.invitedBy),
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: every schema default present.
    fromRow: (row) => ({
      _id: new Types.ObjectId(String(row.id)),
      email: row.email ?? null,
      name: row.name ?? '',
      organization: row.organization ?? '',
      useCase: row.use_case ?? '',
      note: row.note ?? '',
      status: row.status ?? 'pending',
      invitationCode: idOrNull(row.invitation_code),
      invitedAt: dateOrNull(row.invited_at),
      invitationSentAt: dateOrNull(row.invitation_sent_at),
      invitedBy: idOrNull(row.invited_by),
      ...(row.created_at == null ? {} : { createdAt: dateOrNull(row.created_at) }),
      ...(row.updated_at == null ? {} : { updatedAt: dateOrNull(row.updated_at) }),
    }),
  });
  return store;
}

/**
 * Throws in pg mode, until step 4. Every write here refuses in pg; a route
 * that does other work before its write (send-invitation creates an
 * invitation code and emails it first) calls this first, so pg refuses before
 * anything is written or sent.
 */
export const assertWaitlistWritable = (operation: string): void => {
  if (storeMode(NAME) === 'pg') {
    throw new Error(`dual-store: ${NAME} ${operation} is not supported in pg mode until step 4`
      + ' (docs/runbooks/adr-034-model-move.md)');
  }
};

/**
 * Hydrated (mongo mode) or plain (every other mode) waitlist request. Callers
 * read fields only, so both serve them.
 */
export type WaitlistRequestRow = {
  _id: Types.ObjectId; email: string; name: string; organization: string; useCase: string; note: string;
  status: WaitlistStatus; invitationCode?: unknown; invitedAt?: Date | null; invitationSentAt?: Date | null;
  invitedBy?: unknown; createdAt?: Date; updatedAt?: Date;
};

const POPULATED_REFS: Array<{ path: 'invitationCode' | 'invitedBy'; load: (ids: string[]) => Promise<Doc[]> }> = [
  {
    path: 'invitationCode',
    load: (ids) => InvitationCode.find({ _id: { $in: ids } }).select('code').lean() as Promise<Doc[]>,
  },
  {
    path: 'invitedBy',
    load: (ids) => User.find({ _id: { $in: ids } }).select('username email').lean() as Promise<Doc[]>,
  },
];

/**
 * What `.populate('invitationCode', 'code').populate('invitedBy', 'username
 * email').lean()` returns, done by hand on plain documents (findPageMongo and
 * the helper's reads cannot populate): each set ref becomes the referenced
 * document's `{ _id, code }` or `{ _id, username, email }`, or null when that
 * document no longer exists; a null ref stays null and an absent one absent.
 * Both referenced models are still Mongo's, so this reads Mongo in every mode.
 */
export async function populateWaitlistRefs(docs: Doc[]): Promise<Doc[]> {
  const found = await Promise.all(POPULATED_REFS.map(async ({ path, load }) => {
    const ids = [...new Set(docs.map((doc) => doc[path]).filter((value) => value != null).map(String))];
    const refs = ids.length ? await load(ids) : [];
    return new Map(refs.map((ref) => [String(ref._id), ref]));
  }));
  return docs.map((doc) => {
    const out = { ...doc };
    POPULATED_REFS.forEach(({ path }, index) => {
      if (out[path] != null) out[path] = found[index].get(String(out[path])) ?? null;
    });
    return out;
  });
}

/**
 * The person's pending request, if any, before a new one is created. mongo
 * makes the pre-step-2 `findOne({ email, status: 'pending' })` (hydrated).
 * dual and pg-read read Mongo (findPageMongo, limit 1): the answer decides
 * whether this request writes, and Mongo decides every write there, so a
 * Postgres row lagging another process's create cannot let a duplicate in.
 * pg reads Postgres.
 */
export async function findPendingWaitlistRequest(email: string): Promise<WaitlistRequestRow | null> {
  const filter = { email, status: 'pending' };
  const mode = storeMode(NAME);
  if (mode === 'mongo') return WaitlistRequest.findOne(filter) as unknown as Promise<WaitlistRequestRow | null>;
  if (mode === 'pg') {
    return waitlistRequestStore().findOneWhere(filter) as unknown as Promise<WaitlistRequestRow | null>;
  }
  const [doc] = await waitlistRequestStore().findPageMongo(filter, { limit: 1 });
  return (doc ?? null) as WaitlistRequestRow | null;
}

export type WaitlistRequestInsert = {
  email: string; name: string; organization: string; useCase: string; note: string; status: WaitlistStatus;
};

/**
 * Creates a request. mongo makes the pre-step-2 `create`; dual and pg-read
 * the helper's `create` (Mongo first, then the copy). pg refuses until step
 * 4, before any write.
 */
export async function createWaitlistRequest(fields: WaitlistRequestInsert): Promise<WaitlistRequestRow> {
  assertWaitlistWritable('createWaitlistRequest');
  if (storeMode(NAME) === 'mongo') return WaitlistRequest.create(fields) as unknown as Promise<WaitlistRequestRow>;
  return waitlistRequestStore().create(fields) as unknown as Promise<WaitlistRequestRow>;
}

/**
 * The admin list's filter: a case-insensitive search of email, name and
 * organization, and a status. `q` goes into `$regex` as given (unescaped), as
 * it did before this move; only admins reach it.
 */
const listFilter = (q: string, status: string): Doc => {
  const query: Doc = {};
  if (q) {
    query.$or = [
      { email: { $regex: q, $options: 'i' } },
      { name: { $regex: q, $options: 'i' } },
      { organization: { $regex: q, $options: 'i' } },
    ];
  }
  if (['pending', 'invited', 'closed'].includes(status)) {
    query.status = status;
  }
  return query;
};

/**
 * One page of the admin list, newest first, with its refs populated, and the
 * total. mongo makes the pre-step-2 `find(query).populate(..).populate(..)
 * .sort({ createdAt: -1 }).skip().limit().lean()` and `countDocuments(query)`.
 * dual and pg-read read Mongo through `findPageMongo` (the search is a
 * `$regex` Postgres never runs; ties on createdAt break by _id) and
 * `countMongo`, and populate by hand. pg refuses until step 4 (both helpers
 * do): the list needs an ILIKE form with its own parity check first.
 */
export async function listWaitlistRequests(
  { q, status, skip, limit }: { q: string; status: string; skip: number; limit: number },
): Promise<{ requests: Doc[]; total: number }> {
  const query = listFilter(q, status);
  if (storeMode(NAME) === 'mongo') {
    const [requests, total] = await Promise.all([
      WaitlistRequest.find(query)
        .populate('invitationCode', 'code')
        .populate('invitedBy', 'username email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WaitlistRequest.countDocuments(query),
    ]);
    return { requests: requests as unknown as Doc[], total };
  }
  const [page, total] = await Promise.all([
    waitlistRequestStore().findPageMongo(query, { sort: { createdAt: -1 }, skip, limit }),
    waitlistRequestStore().countMongo(query),
  ]);
  return { requests: await populateWaitlistRefs(page), total };
}

/**
 * Sets a request's status (and, on a close, nulls its invitation fields),
 * returning it populated, or null when there is none. mongo makes the
 * pre-step-2 `findByIdAndUpdate(id, { $set }, { new: true })` with the two
 * populates (hydrated). dual and pg-read make the helper's `update`, decided
 * on Mongo, which stores each null in both stores as mongo mode does, then
 * populate by hand. pg refuses until step 4, before any write.
 */
export async function setWaitlistRequestStatus(id: unknown, update: Doc): Promise<Doc | null> {
  assertWaitlistWritable('setWaitlistRequestStatus');
  if (storeMode(NAME) === 'mongo') {
    return WaitlistRequest.findByIdAndUpdate(id, { $set: update }, { new: true })
      .populate('invitationCode', 'code')
      .populate('invitedBy', 'username email') as unknown as Promise<Doc | null>;
  }
  const doc = await waitlistRequestStore().update(id as string, update);
  if (!doc) return null;
  const [populated] = await populateWaitlistRefs([doc]);
  return populated;
}

/**
 * The request an admin is about to send an invitation for. mongo makes the
 * pre-step-2 `findById(id)` (hydrated, so markWaitlistRequestInvited can
 * save it). dual and pg-read read Mongo (findPageMongo, limit 1): this read
 * decides where an invitation code, an access grant, is emailed, and a
 * Postgres row lagging a write must not answer it. pg reads Postgres.
 */
export async function findWaitlistRequestForInvitation(id: unknown): Promise<WaitlistRequestRow | null> {
  const mode = storeMode(NAME);
  if (mode === 'mongo') return WaitlistRequest.findById(id) as unknown as Promise<WaitlistRequestRow | null>;
  if (mode === 'pg') {
    return waitlistRequestStore().findById(id as string) as unknown as Promise<WaitlistRequestRow | null>;
  }
  const [doc] = await waitlistRequestStore().findPageMongo({ _id: id }, { limit: 1 });
  return (doc ?? null) as WaitlistRequestRow | null;
}

export type WaitlistInvitedFields = {
  status: 'invited'; invitationCode: unknown; invitedAt: Date; invitationSentAt: Date; invitedBy: unknown;
};

/**
 * Records that an invitation went out for `request` (from
 * findWaitlistRequestForInvitation). mongo assigns the fields and makes the
 * pre-step-2 `save()` on the hydrated document. dual and pg-read make the
 * helper's `update` on its id, decided on Mongo, and throw when the request
 * is gone, as `save()` does. pg refuses until step 4, before any write.
 */
export async function markWaitlistRequestInvited(
  request: WaitlistRequestRow, fields: WaitlistInvitedFields,
): Promise<void> {
  assertWaitlistWritable('markWaitlistRequestInvited');
  if (storeMode(NAME) === 'mongo') {
    const doc = request as unknown as Doc & { save: () => Promise<unknown> };
    Object.assign(doc, fields);
    await doc.save();
    return;
  }
  const updated = await waitlistRequestStore().update(request._id, fields as unknown as Doc);
  if (!updated) throw new Error(`dual-store: ${NAME} ${String(request._id)} no longer exists`);
}

/**
 * A request with its refs populated, for a response. mongo makes the
 * pre-step-2 `findById(id).populate(..).populate(..).lean()`. dual reads
 * Mongo, pg-read Postgres unless a document is flagged, pg Postgres (the
 * helper's findById), and populate by hand. It only shows the request; it
 * decides nothing.
 */
export async function findWaitlistRequestPopulated(id: unknown): Promise<Doc | null> {
  if (storeMode(NAME) === 'mongo') {
    return WaitlistRequest.findById(id)
      .populate('invitationCode', 'code')
      .populate('invitedBy', 'username email')
      .lean() as unknown as Promise<Doc | null>;
  }
  const doc = await waitlistRequestStore().findById(id as string);
  if (!doc) return null;
  const [populated] = await populateWaitlistRefs([doc]);
  return populated;
}
