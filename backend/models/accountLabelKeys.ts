/**
 * Case-insensitive account labels without collation.
 *
 * The account-label checks (a signup's username, a renamed username, a chosen
 * display name) must refuse a label another account holds in any case: "Sam"
 * holds "sam". They used a { locale: 'en', strength: 2 } collation. FerretDB,
 * which self-hosted instances can run in place of MongoDB, rejects collation on
 * updates and indexes and silently IGNORES it on reads, so those checks would
 * pass a case-variant duplicate (fail open). Prod Mongo never built the
 * collation indexes either (the name collided with the unique username index,
 * checked 2026-10-17), so the checks were unindexed scans there too.
 *
 * Instead each user carries lowercase copies of its labels under `labelKeys`,
 * kept in step by this plugin on every save, insertMany and query update, and
 * the checks match the copies exactly: one indexed query that behaves the same
 * on both stores. `accountLabelClause` also matches a user whose key was never
 * written (an account from before this plugin, until the backfill
 * scripts/backfill-user-label-keys.ts has run) by an anchored case-insensitive
 * regex on the label itself, so the check is never weaker during the rollout.
 */
import type { Schema } from 'mongoose';

type Doc = Record<string, any>;

/** The comparison form of a label. Absent stays null, so "no label" is written, not missing. */
export const labelKey = (value: unknown): string | null => (
  typeof value === 'string' ? value.toLowerCase() : null
);

/** label field → its key path. */
export const LABEL_KEY_PATHS = {
  username: 'labelKeys.username',
  previousUsernames: 'labelKeys.previousUsernames',
  displayName: 'labelKeys.displayName',
  'botMetadata.displayName': 'labelKeys.botDisplayName',
} as const;
export type AccountLabelField = keyof typeof LABEL_KEY_PATHS;

/** Every key, computed from a whole document. */
export const labelKeysFor = (doc: Doc) => ({
  username: labelKey(doc.username),
  previousUsernames: (Array.isArray(doc.previousUsernames) ? doc.previousUsernames : [])
    .map(labelKey).filter((key: string | null): key is string => key !== null),
  displayName: labelKey(doc.displayName),
  botDisplayName: labelKey(doc.botMetadata?.displayName),
});

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A filter clause matching any user whose `field` equals `value` ignoring case.
 * Combine clauses with $or. The second branch covers a user whose key was never
 * written; it is dropped once the backfill verifies (see the file comment).
 */
export const accountLabelClause = (field: AccountLabelField, value: string): Doc => {
  const keyPath = LABEL_KEY_PATHS[field];
  return {
    $or: [
      { [keyPath]: labelKey(value) },
      { [keyPath]: { $exists: false }, [field]: { $regex: `^${escapeRegex(value)}$`, $options: 'i' } },
    ],
  };
};

/**
 * The key writes an update implies, per operator. A label set or unset sets or
 * nulls its key; previousUsernames pushed or added adds its key the same way.
 * A whole botMetadata object set carries its displayName key along.
 */
const keyWritesFor = (update: Doc): Doc => {
  const writes: Doc = {};
  const put = (op: string, path: string, value: unknown) => {
    writes[op] = { ...(writes[op] || {}), [path]: value };
  };
  const setLike = (op: '$set' | '$setOnInsert', fields: Doc) => {
    if ('username' in fields) put(op, LABEL_KEY_PATHS.username, labelKey(fields.username));
    if ('displayName' in fields) put(op, LABEL_KEY_PATHS.displayName, labelKey(fields.displayName));
    if ('botMetadata.displayName' in fields) {
      put(op, LABEL_KEY_PATHS['botMetadata.displayName'], labelKey(fields['botMetadata.displayName']));
    }
    if ('botMetadata' in fields) {
      put(op, LABEL_KEY_PATHS['botMetadata.displayName'], labelKey(fields.botMetadata?.displayName));
    }
    if ('previousUsernames' in fields) {
      put(op, LABEL_KEY_PATHS.previousUsernames, labelKeysFor({ previousUsernames: fields.previousUsernames })
        .previousUsernames);
    }
  };
  // A plain object without operators is a $set (Mongoose wraps it the same way).
  const plain = Object.fromEntries(Object.entries(update).filter(([key]) => !key.startsWith('$')));
  if (Object.keys(plain).length) setLike('$set', plain);
  if (update.$set) setLike('$set', update.$set);
  if (update.$setOnInsert) setLike('$setOnInsert', update.$setOnInsert);
  if (update.$unset) {
    const unset = update.$unset as Doc;
    if ('username' in unset) put('$set', LABEL_KEY_PATHS.username, null);
    if ('displayName' in unset) put('$set', LABEL_KEY_PATHS.displayName, null);
    if ('botMetadata.displayName' in unset || 'botMetadata' in unset) {
      put('$set', LABEL_KEY_PATHS['botMetadata.displayName'], null);
    }
    if ('previousUsernames' in unset) put('$set', LABEL_KEY_PATHS.previousUsernames, []);
  }
  for (const op of ['$addToSet', '$push'] as const) {
    const value = update[op]?.previousUsernames;
    if (value === undefined) continue; // eslint-disable-line no-continue
    const items = value && typeof value === 'object' && Array.isArray(value.$each) ? value.$each : [value];
    const keys = items.map(labelKey).filter((key: string | null) => key !== null);
    put(op, LABEL_KEY_PATHS.previousUsernames, op === '$push' || keys.length !== 1 ? { $each: keys } : keys[0]);
  }
  if (update.$pull?.previousUsernames !== undefined) {
    const pulled = labelKey(update.$pull.previousUsernames);
    if (pulled !== null) put('$pull', LABEL_KEY_PATHS.previousUsernames, pulled);
  }
  return writes;
};

const UPDATE_OPS = ['updateOne', 'updateMany', 'findOneAndUpdate'] as const;

export function accountLabelKeysPlugin(schema: Schema): void {
  schema.add({
    labelKeys: {
      username: { type: String, default: undefined },
      previousUsernames: { type: [String], default: undefined },
      displayName: { type: String, default: undefined },
      botDisplayName: { type: String, default: undefined },
    },
  });
  schema.index({ 'labelKeys.username': 1 });
  schema.index({ 'labelKeys.previousUsernames': 1 });
  schema.index({ 'labelKeys.displayName': 1 });
  schema.index({ 'labelKeys.botDisplayName': 1 });

  // Every save recomputes every key, so a document never leaves a save with a
  // stale one, whatever path assigned the label.
  schema.pre('validate', function setLabelKeys(this: any) {
    this.set('labelKeys', labelKeysFor(this.toObject({ depopulate: true })));
  });
  schema.pre('insertMany', (next: () => void, docs: Doc[]) => {
    (Array.isArray(docs) ? docs : [docs]).forEach((doc) => {
      if (doc && typeof doc === 'object') doc.labelKeys = labelKeysFor(doc); // eslint-disable-line no-param-reassign
    });
    next();
  });
  UPDATE_OPS.forEach((op) => {
    schema.pre(op, function addLabelKeyWrites(this: any) {
      const update = this.getUpdate();
      if (!update) return;
      if (Array.isArray(update)) {
        // No pipeline update writes a label today. Refuse one rather than let
        // it leave a stale key that a case-insensitive check would trust.
        const touches = JSON.stringify(update);
        if (/"(username|displayName|previousUsernames|botMetadata)/.test(touches)) {
          throw new Error('account labels cannot be written by a pipeline update; use operators');
        }
        return;
      }
      const writes = keyWritesFor(update);
      Object.entries(writes).forEach(([operator, fields]) => {
        update[operator] = { ...(update[operator] || {}), ...fields };
      });
      this.setUpdate(update);
    });
  });
}
