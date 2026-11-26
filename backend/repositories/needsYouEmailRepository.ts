import { Types } from 'mongoose';
import NeedsYouEmail from '../models/NeedsYouEmail';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'NeedsYouEmail';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('needs_you_emails: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

const dateOrNull = (value: unknown): Date | null => (value == null ? null : new Date(value as string));

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for the per-ask needs-you email record, selected by
 * STORE_MODE_NEEDS_YOU_EMAIL. Table: config/migrations/0024_needs_you_emails.sql.
 * Built on first use outside mongo, so mongo mode loads nothing new.
 *
 * clickToken is `select: false` in the schema: the helper names it in the
 * reads it copies from and drops it from what it hands back, and every read
 * here names its fields, so no read returns the token where Mongo wouldn't.
 *
 * clicked_at and included_in_digest_at are presence columns: their only
 * writers set them to a time, never to null, so a NULL column is exactly a
 * missing Mongo field and `$exists` on them means the same in both stores.
 */
export function needsYouEmailStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: NeedsYouEmail,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'needs_you_emails',
      idColumn: 'id',
      columns: ['attention_item_id', 'recipient_user_id', 'click_token', 'status', 'sent_at', 'clicked_at',
        'included_in_digest_at', 'created_at', 'updated_at'],
      presenceColumns: ['clicked_at', 'included_in_digest_at'],
    }),
    filterColumns: {
      _id: 'id',
      attentionItemId: 'attention_item_id',
      recipientUserId: 'recipient_user_id',
      clickToken: 'click_token',
      status: 'status',
      clickedAt: 'clicked_at',
      includedInDigestAt: 'included_in_digest_at',
    },
    toRow: (doc) => ({
      id: String(doc._id),
      attention_item_id: doc.attentionItemId == null ? null : String(doc.attentionItemId),
      recipient_user_id: doc.recipientUserId == null ? null : String(doc.recipientUserId),
      click_token: doc.clickToken ?? null,
      status: doc.status ?? null,
      sent_at: doc.sentAt ?? null,
      clicked_at: doc.clickedAt ?? null,
      included_in_digest_at: doc.includedInDigestAt ?? null,
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: ObjectIds, and no optional field until it is set.
    fromRow: (row) => ({
      _id: new Types.ObjectId(String(row.id)),
      attentionItemId: new Types.ObjectId(String(row.attention_item_id)),
      recipientUserId: new Types.ObjectId(String(row.recipient_user_id)),
      ...(row.click_token == null ? {} : { clickToken: row.click_token }),
      status: row.status,
      ...(row.sent_at == null ? {} : { sentAt: dateOrNull(row.sent_at) }),
      ...(row.clicked_at == null ? {} : { clickedAt: dateOrNull(row.clicked_at) }),
      ...(row.included_in_digest_at == null ? {} : { includedInDigestAt: dateOrNull(row.included_in_digest_at) }),
      ...(row.created_at == null ? {} : { createdAt: dateOrNull(row.created_at) }),
      ...(row.updated_at == null ? {} : { updatedAt: dateOrNull(row.updated_at) }),
    }),
  });
  return store;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

const refuseInPg = (operation: string): void => {
  if (storeMode(NAME) === 'pg') {
    throw new Error(`dual-store: ${NAME} ${operation} is not supported in pg mode until step 4`
      + ' (docs/runbooks/adr-034-model-move.md)');
  }
};

export type NeedsYouClaim = { attentionItemId: unknown; recipientUserId: unknown; clickToken: string };

/**
 * Claims the one email an attention item may get: the claim's id, or null
 * when the item was already claimed (Mongo's unique attentionItemId).
 *
 * mongo makes the pre-step-2 `create`. dual and pg-read insert through the
 * helper's `create`, whose duplicate key propagates from Mongo before any
 * copy; a copy that fails after the insert never fails the claim (the marker
 * stays for `repair`). pg refuses until step 4, before any write.
 */
export async function claimNeedsYouEmail(claim: NeedsYouClaim): Promise<unknown | null> {
  refuseInPg('claimNeedsYouEmail');
  const doc = { ...claim, status: 'claimed' };
  try {
    const created = storeMode(NAME) === 'mongo'
      ? await NeedsYouEmail.create(doc)
      : await needsYouEmailStore().create(doc);
    return created._id;
  } catch (error) {
    if (isDuplicateKey(error)) return null;
    throw error;
  }
}

export type NeedsYouStatus = { status: 'sent' | 'overflow' | 'failed'; sentAt?: Date };

/**
 * Sets a claim's status (and sentAt with 'sent'). A key whose value is
 * undefined writes nothing, as Mongoose drops it from `$set` in mongo.
 *
 * mongo makes the pre-step-2 `updateOne({ _id }, { $set })`. dual and pg-read
 * make the helper's `update`. pg refuses until step 4, before any write.
 */
export async function setNeedsYouEmailStatus(id: unknown, fields: NeedsYouStatus): Promise<void> {
  refuseInPg('setNeedsYouEmailStatus');
  if (storeMode(NAME) === 'mongo') {
    await NeedsYouEmail.updateOne({ _id: id }, { $set: fields });
    return;
  }
  const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  await needsYouEmailStore().update(id, defined);
}

/**
 * The claim an email link's token belongs to, as its id and attention item,
 * or null for an unknown token.
 *
 * Mongo in every mode but pg, pg-read included. pg-read's flag check is a
 * per-instance cache: another instance can commit a claim to Mongo and fail
 * its copy while this one still caches "nothing flagged", and a Postgres read
 * would then answer unknown and break the link in an email someone has just
 * received. That fails closed, but it is a dead link for a person, not a
 * delayed line in a digest, so the lookup does not read a copy that can lag.
 * In pg it reads Postgres, which is then the only store.
 */
export async function findNeedsYouClick(token: string): Promise<{ _id: unknown; attentionItemId: unknown } | null> {
  const row = storeMode(NAME) !== 'pg'
    ? await NeedsYouEmail.findOne({ clickToken: token }).select('+clickToken attentionItemId')
    : await needsYouEmailStore().findOneWhere({ clickToken: token }, { fields: ['attentionItemId'] });
  if (!row) return null;
  return { _id: row._id, attentionItemId: (row as { attentionItemId?: unknown }).attentionItemId };
}

/**
 * Stamps the first click on a claim; a later click changes nothing.
 *
 * mongo makes the pre-step-2 `updateOne` on `clickedAt: { $exists: false }`.
 * dual and pg-read make the helper's `updateWhere` on the same filter, which
 * runs on Mongo, so only the first click takes a version and a copy. pg
 * refuses until step 4 (updateWhere does).
 */
export async function markNeedsYouClicked(id: unknown, at: Date = new Date()): Promise<boolean> {
  const filter = { _id: id, clickedAt: { $exists: false } };
  if (storeMode(NAME) === 'mongo') {
    const result = await NeedsYouEmail.updateOne(filter, { $set: { clickedAt: at } });
    return result.modifiedCount > 0;
  }
  return needsYouEmailStore().updateWhere(filter, [{ $set: { clickedAt: { $literal: at } } }]);
}

/**
 * The recipient's overflow claims no digest has carried yet, as `_id` and
 * `attentionItemId` only (never the click token).
 *
 * mongo makes the pre-step-2 `find(...).select('_id attentionItemId').lean()`.
 * dual reads Mongo; pg-read reads Postgres unless a document is flagged.
 * A stale Postgres answer here loses nothing: an ask whose overflow has not
 * been copied yet waits for the next digest, and one whose digest mark has
 * not been copied is shown in one more digest. The digest re-reads every ask
 * from Mongo (open, the recipient's, in a pod they are still in) before
 * showing it.
 */
export async function listUndigestedOverflow(recipientUserId: unknown): Promise<Array<{
  _id: unknown; attentionItemId: unknown;
}>> {
  const filter = { recipientUserId, status: 'overflow', includedInDigestAt: { $exists: false } };
  if (storeMode(NAME) === 'mongo') {
    return NeedsYouEmail.find(filter).select('_id attentionItemId').lean() as unknown as Promise<Array<{
      _id: unknown; attentionItemId: unknown;
    }>>;
  }
  return await needsYouEmailStore().findWhere(filter, { fields: ['attentionItemId'] }) as Array<{
    _id: unknown; attentionItemId: unknown;
  }>;
}

/**
 * Marks the claims a sent digest carried, each once: the number marked.
 *
 * mongo makes the pre-step-2 `updateMany`. dual and pg-read make the helper's
 * `updateManyWhere` on the same filter, so each claim still unmarked takes
 * its own version and copy. pg refuses until step 4 (updateManyWhere does).
 * An empty list marks nothing and makes no call.
 */
export async function markIncludedInDigest(ids: unknown[], at: Date): Promise<number> {
  if (!ids.length) return 0;
  const filter = { _id: { $in: ids }, includedInDigestAt: { $exists: false } };
  if (storeMode(NAME) === 'mongo') {
    const result = await NeedsYouEmail.updateMany(filter, { $set: { includedInDigestAt: at } });
    return result.modifiedCount;
  }
  return needsYouEmailStore().updateManyWhere(filter, [{ $set: { includedInDigestAt: { $literal: at } } }]);
}
