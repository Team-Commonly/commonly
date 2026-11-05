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
 * Instead each user carries folded copies of its labels under `labelKeys`
 * (see `labelKey`), kept in step by this plugin on every save, insertMany,
 * query update, replace and bulkWrite, and the checks match the copies exactly:
 * one indexed query that behaves the same on both stores. `accountLabelClause`
 * also matches a user whose key was never written (an account from before this
 * plugin, until the backfill scripts/backfill-user-label-keys.ts has run) by an
 * anchored case-insensitive regex on the label itself.
 *
 * A write the plugin cannot key correctly is refused rather than allowed to
 * leave a stale key a check would trust: a pipeline update, a positional or
 * $rename write on a label, an operator that removes array items from
 * previousUsernames ($pull, $pullAll, $pop), a $push modifier other than $each,
 * and a caller's own write to `labelKeys`. Writes through `User.collection`
 * bypass Mongoose and therefore this plugin; the backfill's --verify finds them.
 */
import { Model } from 'mongoose';
import type { Schema } from 'mongoose';

type Doc = Record<string, any>;

/**
 * Unicode default-ignorable code points: zero-width space and joiners, soft
 * hyphen, variation selectors, word joiner and the like. They render as
 * nothing, and the old collation ignored them, so "sam" and "sam" + U+200B
 * were one label. Keys drop them.
 */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
export const stripIgnorables = (value: string): string => value.replace(IGNORABLE, '');

/**
 * The same set as a regex character class, written out because the server's
 * regex engine has no Default_Ignorable_Code_Point property. A test pins it
 * to the property.
 */
export const IGNORABLE_CLASS = `[${[
  [0xad], [0x34f], [0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x206f], [0x3164], [0xfe00, 0xfe0f], [0xfeff], [0xffa0], [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
].map(([from, to]) => String.fromCodePoint(from) + (to ? `-${String.fromCodePoint(to)}` : '')).join('')}]`;

/**
 * The comparison form of a label: compatibility-normalized (NFKC folds
 * full-width forms, ligatures, and composed vs combining accents), stripped
 * of default-ignorable code points, then upper- and lower-cased so every case
 * form lands on one key (Greek final sigma ς and σ both become σ). Absent
 * stays null, so "no label" is written, not missing.
 */
export const labelKey = (value: unknown): string | null => {
  if (typeof value === 'number') return labelKey(String(value));
  return typeof value === 'string'
    ? stripIgnorables(value.normalize('NFKC')).toUpperCase().toLowerCase()
    : null;
};

/** label field → its key path. */
export const LABEL_KEY_PATHS = {
  username: 'labelKeys.username',
  previousUsernames: 'labelKeys.previousUsernames',
  displayName: 'labelKeys.displayName',
  'botMetadata.displayName': 'labelKeys.botDisplayName',
} as const;
export type AccountLabelField = keyof typeof LABEL_KEY_PATHS;
const LABEL_FIELDS = Object.keys(LABEL_KEY_PATHS) as AccountLabelField[];

/**
 * Labels whose User schema path has `trim: true`. Mongoose trims those on
 * cast, which runs after the update hooks see the raw value, so the key is
 * computed from the trimmed value here. A test pins this to the schema.
 */
export const TRIMMED_LABEL_FIELDS: ReadonlySet<string> = new Set(['displayName']);

/** The value as the schema will store it (the trim part of the cast). */
const castLabel = (field: string, value: unknown): unknown => (
  typeof value === 'string' && TRIMMED_LABEL_FIELDS.has(field) ? value.trim() : value
);
// Ignorables go before the trim, so a label padded with them keys like the
// trimmed label (U+200B + " Sam " and "Sam").
const keyOf = (field: AccountLabelField, value: unknown) => labelKey(
  castLabel(field, typeof value === 'string' ? stripIgnorables(value) : value),
);
const previousKeys = (value: unknown): string[] => (Array.isArray(value) ? value : [])
  .map(labelKey).filter((key: string | null): key is string => key !== null);

/** Every key, computed from a whole document. */
export const labelKeysFor = (doc: Doc) => ({
  username: keyOf('username', doc.username),
  previousUsernames: previousKeys(doc.previousUsernames),
  displayName: keyOf('displayName', doc.displayName),
  botDisplayName: keyOf('botMetadata.displayName', doc.botMetadata?.displayName),
});

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A filter clause matching any user whose `field` equals `value` ignoring case.
 * Combine clauses with $or.
 *
 * The second branch covers a user whose key was never written. It matches the
 * value's composed, decomposed and compatibility spellings with the `i` flag,
 * but a regex cannot normalize the STORED label, so it is weaker than the key:
 * it misses, for example, a full-width stored label checked with an ASCII value
 * when the stored form is not one of the value's spellings, and the regex `i`
 * flag does not fold ς with σ. Default-ignorable code points are stripped from
 * the value and allowed anywhere in the stored label, so "Lily" + U+200D and
 * "Lily" find each other both ways; a stored display name whose ignorables sit
 * outside a space the schema's trim kept (U+200B + " Sam") is still missed. The
 * backfill writes every key and closes these gaps; the branch is dropped once
 * the backfill verifies.
 */
export const accountLabelClause = (field: AccountLabelField, value: string): Doc => {
  const keyPath = LABEL_KEY_PATHS[field];
  const cast = String(castLabel(field, stripIgnorables(String(value))));
  const spellings = Array.from(new Set(
    (['NFC', 'NFD', 'NFKC', 'NFKD'] as const).map((form) => cast.normalize(form)).concat(cast),
  ));
  // Each code point escaped, with any run of ignorables allowed around it.
  const pattern = (spelling: string) => Array.from(spelling).map(escapeRegex).join(`${IGNORABLE_CLASS}*`);
  return {
    $or: [
      { [keyPath]: labelKey(cast) },
      {
        [keyPath]: { $exists: false },
        [field]: {
          $regex: `^${IGNORABLE_CLASS}*(?:${spellings.map(pattern).join('|')})${IGNORABLE_CLASS}*$`,
          $options: 'i',
        },
      },
    ],
  };
};

const refuse = (what: string): never => {
  throw new Error(
    `account labels cannot be written by ${what}; it would leave a stale label key (models/accountLabelKeys.ts)`,
  );
};

/** Does a dotted path write a label, sit under one, or replace a parent of one? */
const touchedLabels = (path: string): AccountLabelField[] => LABEL_FIELDS.filter((label) => (
  path === label || path.startsWith(`${label}.`) || label.startsWith(`${path}.`)
));
const isKeyPath = (path: string) => path === 'labelKeys' || path.startsWith('labelKeys.');

/**
 * The key writes an update implies, per operator. A label set or unset sets or
 * nulls its key; previousUsernames pushed or added adds its key the same way.
 * A whole botMetadata object set or unset carries its displayName key along.
 * Every other write that touches a label is refused (see the file comment).
 */
const keyWritesFor = (update: Doc): Doc => {
  const writes: Doc = {};
  const put = (op: string, path: string, value: unknown) => {
    writes[op] = { ...(writes[op] || {}), [path]: value };
  };
  const setLike = (op: string, fields: Doc) => {
    Object.entries(fields).forEach(([path, value]) => {
      if (isKeyPath(path)) refuse(`a direct ${op} of labelKeys`);
      touchedLabels(path).forEach((label) => {
        if (path === label) {
          put(op, LABEL_KEY_PATHS[label], label === 'previousUsernames' ? previousKeys(value) : keyOf(label, value));
        } else if (path === 'botMetadata') {
          put(op, LABEL_KEY_PATHS[label], keyOf(label, value?.displayName));
        } else {
          refuse(`a positional or nested ${op} ("${path}")`);
        }
      });
    });
  };
  const unset = (fields: Doc) => {
    Object.keys(fields).forEach((path) => {
      if (isKeyPath(path)) refuse('a direct $unset of labelKeys');
      touchedLabels(path).forEach((label) => {
        if (path !== label && path !== 'botMetadata') refuse(`a positional or nested $unset ("${path}")`);
        put('$set', LABEL_KEY_PATHS[label], label === 'previousUsernames' ? [] : null);
      });
    });
  };
  const pushLike = (op: '$push' | '$addToSet', fields: Doc) => {
    Object.entries(fields).forEach(([path, value]) => {
      if (isKeyPath(path)) refuse(`a direct ${op} to labelKeys`);
      const labels = touchedLabels(path);
      if (!labels.length) return;
      if (path !== 'previousUsernames') refuse(`${op} on "${path}"`);
      const isEach = value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).some((key) => key.startsWith('$'));
      if (isEach && (!Array.isArray(value.$each) || Object.keys(value).some((key) => key !== '$each'))) {
        refuse(`${op} with a modifier other than $each`);
      }
      const keys = previousKeys(isEach ? value.$each : [value]);
      put(op, LABEL_KEY_PATHS.previousUsernames, { $each: keys });
    });
  };

  Object.entries(update).forEach(([op, fields]) => {
    if (!op.startsWith('$')) return;
    if (!fields || typeof fields !== 'object') return;
    if (op === '$set' || op === '$setOnInsert') setLike(op, fields);
    else if (op === '$unset') unset(fields);
    else if (op === '$push' || op === '$addToSet') pushLike(op, fields);
    else {
      // $pull, $pullAll, $pop, $rename, $inc, $min, $max, $mul, $currentDate, $bit.
      Object.entries(fields).forEach(([path, target]) => {
        const renameTarget = op === '$rename' && typeof target === 'string' ? target : '';
        if (isKeyPath(path) || (renameTarget && isKeyPath(renameTarget))) refuse(`${op} on labelKeys`);
        if (touchedLabels(path).length || (renameTarget && touchedLabels(renameTarget).length)) {
          refuse(`${op} ("${path}"${renameTarget ? ` → "${renameTarget}"` : ''})`);
        }
      });
    }
  });
  // A plain object without operators is a $set (Mongoose wraps it the same way).
  const plain = Object.fromEntries(Object.entries(update).filter(([key]) => !key.startsWith('$')));
  if (Object.keys(plain).length) setLike('$set', plain);
  return writes;
};

/**
 * An upsert copies the filter's equality fields into the inserted document, so
 * a label named only in the filter needs its key on insert too.
 */
const upsertKeyWrites = (filter: Doc | undefined, writes: Doc): Doc => {
  if (!filter || typeof filter !== 'object') return {};
  const written = new Set(Object.values(writes).flatMap((fields: Doc) => Object.keys(fields)));
  const onInsert: Doc = {};
  (['username', 'displayName', 'botMetadata.displayName'] as const).forEach((label) => {
    const value = filter[label];
    if (typeof value === 'string' && !written.has(LABEL_KEY_PATHS[label])) {
      onInsert[LABEL_KEY_PATHS[label]] = keyOf(label, value);
    }
  });
  return Object.keys(onInsert).length ? { $setOnInsert: onInsert } : {};
};

const PIPELINE_LABEL = /"(username|displayName|previousUsernames|botMetadata|labelKeys)/;

/** The update with its key writes merged in; throws on a write it cannot key. */
export const withLabelKeyWrites = (update: any, filter?: Doc, upsert = false): any => {
  if (!update || typeof update !== 'object') return update;
  if (Array.isArray(update)) {
    // No pipeline update writes a label today. Refuse one rather than let
    // it leave a stale key that a case-insensitive check would trust.
    if (PIPELINE_LABEL.test(JSON.stringify(update))) refuse('a pipeline update; use operators');
    return update;
  }
  const writes = keyWritesFor(update);
  if (upsert) {
    Object.entries(upsertKeyWrites(filter, writes)).forEach(([op, fields]) => {
      writes[op] = { ...(writes[op] || {}), ...fields };
    });
  }
  const merged: Doc = { ...update };
  Object.entries(writes).forEach(([operator, fields]) => {
    merged[operator] = { ...(merged[operator] || {}), ...fields };
  });
  return merged;
};

/** A replacement document with its keys recomputed from what it stores. */
export const withLabelKeysReplaced = (replacement: any): any => {
  if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) return replacement;
  if ('labelKeys' in replacement) refuse('a replacement that carries its own labelKeys');
  return { ...replacement, labelKeys: labelKeysFor(replacement) };
};

/** One bulkWrite op with its keys written; Mongoose 7 has no bulkWrite middleware. */
const keyedBulkOp = (op: Doc): Doc => {
  if (!op || typeof op !== 'object') return op;
  if (op.insertOne) {
    const document = op.insertOne.document ?? op.insertOne;
    if (document && typeof document === 'object' && 'labelKeys' in document) {
      refuse('an insert that carries its own labelKeys');
    }
    const keyed = { ...document, labelKeys: labelKeysFor(document || {}) };
    return { insertOne: op.insertOne.document ? { ...op.insertOne, document: keyed } : keyed };
  }
  for (const kind of ['updateOne', 'updateMany'] as const) {
    if (op[kind]) {
      const { update, filter, upsert } = op[kind];
      return { [kind]: { ...op[kind], update: withLabelKeyWrites(update, filter, Boolean(upsert)) } };
    }
  }
  if (op.replaceOne) {
    return { replaceOne: { ...op.replaceOne, replacement: withLabelKeysReplaced(op.replaceOne.replacement) } };
  }
  return op;
};

/** Does the update add to previousUsernames ($push or $addToSet)? */
const addsPreviousUsernames = (update: any): boolean => Boolean(update) && !Array.isArray(update)
  && (['$push', '$addToSet'] as const).some((op) => update[op] && typeof update[op] === 'object'
    && Object.prototype.hasOwnProperty.call(update[op], 'previousUsernames'));

/**
 * Before an add to previousUsernames, key the whole array of every matched user
 * that has no previousUsernames key yet (an account from before the plugin).
 * The add then extends a complete key array. Without this it would create the
 * array holding only the added names, and the regex fallback, which runs only
 * while the key is missing, would stop reserving the older ones.
 *
 * The write is compare-and-set on the array it was computed from and goes past
 * Mongoose (it writes nothing but the key); a user whose array changed in
 * between keeps no key and is keyed by the next add or by the backfill.
 */
const keyUnkeyedPreviousUsernames = async (model: any, filter: Doc | undefined, session?: unknown) => {
  const path = LABEL_KEY_PATHS.previousUsernames;
  const unkeyed: Doc[] = await model.find({ $and: [filter || {}, { [path]: { $exists: false } }] })
    .select('previousUsernames').session(session ?? null).lean();
  await Promise.all(unkeyed.map((doc) => model.collection.updateOne(
    { _id: doc._id, [path]: { $exists: false }, previousUsernames: doc.previousUsernames ?? null },
    { $set: { [path]: previousKeys(doc.previousUsernames) } },
    session ? { session } : {},
  )));
};

const UPDATE_OPS = ['updateOne', 'updateMany', 'findOneAndUpdate'] as const;
const REPLACE_OPS = ['replaceOne', 'findOneAndReplace'] as const;

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

  // A new document gets every key. An existing one recomputes only the keys
  // whose label this save writes: a document loaded with a partial select
  // (say `.select('_id following')`) holds no labels in memory, and keying
  // its absent labels would overwrite the stored keys with nulls.
  schema.pre('validate', function setLabelKeys(this: any) {
    if (this.isNew) {
      this.set('labelKeys', labelKeysFor(this.toObject({ depopulate: true })));
      return;
    }
    const direct: string[] = this.directModifiedPaths();
    // The label itself, a parent of it, or a path under it (previousUsernames.0).
    const writes = (label: string) => direct.some((path) => (
      path === label || label.startsWith(`${path}.`) || path.startsWith(`${label}.`)
    ));
    if (writes('username')) this.set(LABEL_KEY_PATHS.username, keyOf('username', this.get('username')));
    if (writes('displayName')) this.set(LABEL_KEY_PATHS.displayName, keyOf('displayName', this.get('displayName')));
    if (writes('previousUsernames')) {
      this.set(LABEL_KEY_PATHS.previousUsernames, previousKeys(this.get('previousUsernames')));
    }
    if (writes('botMetadata.displayName')) {
      this.set(
        LABEL_KEY_PATHS['botMetadata.displayName'],
        keyOf('botMetadata.displayName', this.get('botMetadata.displayName')),
      );
    }
  });
  schema.pre('insertMany', (next: () => void, docs: Doc[]) => {
    (Array.isArray(docs) ? docs : [docs]).forEach((doc) => {
      if (doc && typeof doc === 'object') doc.labelKeys = labelKeysFor(doc); // eslint-disable-line no-param-reassign
    });
    next();
  });
  UPDATE_OPS.forEach((op) => {
    schema.pre(op, async function addLabelKeyWrites(this: any) {
      const update = this.getUpdate();
      if (!update) return;
      this.setUpdate(withLabelKeyWrites(update, this.getFilter(), Boolean(this.getOptions()?.upsert)));
      if (addsPreviousUsernames(update)) {
        await keyUnkeyedPreviousUsernames(this.model, this.getFilter(), this.getOptions()?.session);
      }
    });
  });
  REPLACE_OPS.forEach((op) => {
    schema.pre(op, function replaceLabelKeys(this: any) {
      const replacement = this.getUpdate();
      if (replacement) this.setUpdate(withLabelKeysReplaced(replacement));
    });
  });
  // Async, so a refused op rejects the returned promise like a query hook does.
  schema.static('bulkWrite', async function bulkWriteWithLabelKeys(this: any, ops: Doc[], options?: Doc) {
    const keyed = (ops || []).map(keyedBulkOp);
    for (const op of ops || []) {
      const write = op?.updateOne || op?.updateMany;
      if (write && addsPreviousUsernames(write.update)) {
        // eslint-disable-next-line no-await-in-loop -- in op order, before the write
        await keyUnkeyedPreviousUsernames(this, write.filter, options?.session);
      }
    }
    return (Model as any).bulkWrite.call(this, keyed, options);
  });
}
