/**
 * The dual-store helper (ADR-034 D3): moves one Mongo model to a Postgres table
 * in reversible steps, selected per model by `STORE_MODE_<UPPER_SNAKE_NAME>`.
 *
 *   mongo    Mongo only. No Postgres call of any kind. The default.
 *   dual     Mongo is the system of record; every write is copied to Postgres,
 *            and a sample of reads is compared against the copy.
 *   pg-read  Writes as in dual; reads come from Postgres, except while any
 *            document of the model is flagged, when they read Mongo as in dual.
 *   pg       Postgres only.
 *
 * The repair marker travels in the Mongo write itself: each write bumps
 * `pgVersion` and sets `pgPending` to it in one atomic update, and the marker
 * is cleared only by an update that matches that version. A crash anywhere
 * therefore leaves a flagged document that `repair` finishes, and nothing
 * depends on recording a failure after the fact.
 *
 * Deletes are refused outside mongo unless a store opts in with `allowDeletes`.
 * A completed delete removes the document and its row, and with them the
 * version, so a recreated id restarts at version 1 and a late copy, a pg-mode
 * compare-and-set or a backfill of the old document can land on it. Deletes
 * become safe with tombstones in both stores that keep the version; until then
 * a model whose callers delete stays in mongo (docs/runbooks/adr-034-model-move.md).
 */
import { createHash } from 'crypto';
import type { Model, Schema } from 'mongoose';

type StoreMode = 'mongo' | 'dual' | 'pg-read' | 'pg';
const MODES: readonly StoreMode[] = ['mongo', 'dual', 'pg-read', 'pg'];

type Doc = Record<string, unknown>;
type Row = Record<string, unknown>;
type Id = unknown;

/** What the helper needs from a Postgres table. Rows carry their id column. */
interface PgAdapter {
  /** Writes the row unless the stored one is at `version` or newer; true when applied. */
  upsert(row: Row, version: number): Promise<boolean>;
  /** Deletes the row unless the stored one is at `version` or newer. */
  remove(id: string, version: number): Promise<void>;
  /** pg mode: writes the row at `version + 1` only if it is still at `version`; true when applied. */
  replace(row: Row, version: number): Promise<boolean>;
  /** pg mode: deletes the row only if it is still at `version`; true when deleted. */
  removeAt(id: string, version: number): Promise<boolean>;
  get(id: string): Promise<{ row: Row; version: number } | null>;
  /** Rows with an id above `after` (null: from the start), in id byte order, at most `limit`. */
  scan(after: string | null, limit: number): Promise<Array<{ id: string; row: Row; version: number }>>;
}

interface PgQueryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;
}

const warnedModes = new Set<string>();

const modeEnvName = (name: string): string => `STORE_MODE_${name
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/[^A-Za-z0-9]+/g, '_')
  .toUpperCase()}`;

/** Read on every call, so a mode change needs no code path of its own. */
export function storeMode(name: string): StoreMode {
  const env = modeEnvName(name);
  const raw = process.env[env];
  if (raw === undefined || raw === '') return 'mongo';
  if ((MODES as readonly string[]).includes(raw)) return raw as StoreMode;
  if (!warnedModes.has(`${env}=${raw}`)) {
    warnedModes.add(`${env}=${raw}`);
    console.warn(`[dual-store] ${env} is not one of ${MODES.join(', ')}; using mongo`);
  }
  return 'mongo';
}

/** Adds the repair markers. The sparse index makes `repair`'s scan cheap. */
export function dualStorePlugin(schema: Schema): void {
  schema.add({ pgVersion: Number, pgPending: Number, pgDeleted: Boolean });
  schema.index({ pgPending: 1 }, { sparse: true });
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const identifier = (value: string): string => {
  if (!IDENTIFIER.test(value)) throw new Error(`dual-store: unsafe SQL identifier ${JSON.stringify(value)}`);
  return value;
};

/**
 * A PgAdapter over one table with an `INTEGER NOT NULL pg_version` column.
 * Identifiers are interpolated, so they are validated; values are parameters.
 * `jsonColumns` are bound as JSON text: node-postgres binds a JavaScript array
 * as a Postgres array literal, which a json or jsonb column rejects (or, for an
 * empty array, stores as `{}`).
 * `bigintColumns` come back from node-postgres as strings (BIGINT exceeds a
 * 32-bit int); they are read back as numbers, so every caller and the compare
 * see one type, and a value past Number.MAX_SAFE_INTEGER throws, never rounds.
 */
export function pgTableAdapter(
  {
    pool, table, idColumn, columns, jsonColumns = [], bigintColumns = [],
  }: {
    pool: PgQueryable; table: string; idColumn: string; columns: string[];
    jsonColumns?: string[]; bigintColumns?: string[];
  },
): PgAdapter {
  const t = identifier(table);
  const id = identifier(idColumn);
  const cols = columns.map(identifier);
  const json = new Set(jsonColumns.map(identifier));
  if ([...json].some((c) => !cols.includes(c))) throw new Error('dual-store: jsonColumns must be listed in columns');
  const bigint = bigintColumns.map(identifier);
  if (bigint.some((c) => !cols.includes(c))) throw new Error('dual-store: bigintColumns must be listed in columns');
  const read = (raw: Row): Row => {
    const row = { ...raw };
    bigint.forEach((c) => {
      if (row[c] == null) return;
      const value = Number(row[c]);
      if (!Number.isSafeInteger(value)) throw new Error(`dual-store: ${t}.${c} is past the safe integer range`);
      row[c] = value;
    });
    return row;
  };
  const bind = (row: Row, c: string): unknown => {
    const value = row[c] ?? null;
    return json.has(c) && value !== null ? JSON.stringify(value) : value;
  };
  if (cols.includes(id) || cols.includes('pg_version')) {
    throw new Error('dual-store: columns must not repeat the id column or pg_version');
  }
  const all = [id, ...cols];
  const upsertSql = `INSERT INTO ${t} (${all.join(', ')}, pg_version)
    VALUES (${all.map((_, i) => `$${i + 1}`).join(', ')}, $${all.length + 1})
    ON CONFLICT (${id}) DO UPDATE SET ${[...cols, 'pg_version'].map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
    WHERE ${t}.pg_version < EXCLUDED.pg_version`;
  const replaceSql = `UPDATE ${t} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')},
    pg_version = $${cols.length + 2} + 1 WHERE ${id} = $1 AND pg_version = $${cols.length + 2}`;
  return {
    async upsert(row, version) {
      const result = await pool.query(upsertSql, [...all.map((c) => bind(row, c)), version]);
      return (result.rowCount ?? 0) > 0;
    },
    async remove(rowId, version) {
      await pool.query(`DELETE FROM ${t} WHERE ${id} = $1 AND pg_version < $2`, [rowId, version]);
    },
    async replace(row, version) {
      const result = await pool.query(replaceSql, [row[id], ...cols.map((c) => bind(row, c)), version]);
      return (result.rowCount ?? 0) > 0;
    },
    async removeAt(rowId, version) {
      const result = await pool.query(`DELETE FROM ${t} WHERE ${id} = $1 AND pg_version = $2`, [rowId, version]);
      return (result.rowCount ?? 0) > 0;
    },
    async get(rowId) {
      const { rows } = await pool.query(`SELECT ${all.join(', ')}, pg_version FROM ${t} WHERE ${id} = $1`, [rowId]);
      if (!rows[0]) return null;
      const { pg_version: version, ...row } = rows[0];
      return { row: read(row), version: Number(version) };
    },
    async scan(after, limit) {
      // COLLATE "C" pages by byte order whatever the database collation is, so
      // keyset paging never skips or repeats a row.
      const { rows } = await pool.query(
        `SELECT ${all.join(', ')}, pg_version FROM ${t}
          WHERE $1::text IS NULL OR ${id} COLLATE "C" > $1::text
          ORDER BY ${id} COLLATE "C" LIMIT $2`,
        [after, limit],
      );
      return rows.map(({ pg_version: version, ...row }) => ({ id: String(row[id]), row: read(row), version: Number(version) }));
    },
  };
}

// pg-ahead: Postgres holds a version Mongo never wrote, which only a rollback
// from pg that did not carry pg_version back into pgVersion can produce.
type MismatchKind = 'missing' | 'differs' | 'pg-write-failed' | 'pg-ahead';
type Stats = Record<MismatchKind, number>;
const stats = new Map<string, Stats>();

/** Mismatch counts for one model since start (or the last reset). */
export function dualStoreStats(name: string): Stats {
  return {
    missing: 0, differs: 0, 'pg-write-failed': 0, 'pg-ahead': 0, ...stats.get(name),
  };
}
export function resetDualStoreStats(): void {
  stats.clear();
}

const hashId = (id: Id): string => createHash('sha256').update(String(id)).digest('hex').slice(0, 12);

/** Never logs a value or a raw id: only the model, a hashed id, and field names. */
function mismatch(name: string, id: Id, kind: MismatchKind, fields: string[] = []): void {
  const current = dualStoreStats(name);
  current[kind] += 1;
  stats.set(name, current);
  const hashed = hashId(id);
  const listed = fields.length ? ` fields=${fields.join(',')}` : '';
  console.warn(`[dual-store] mismatch model=${name} id=${hashed} kind=${kind}${listed}`);
}

/** Store-neutral form for comparison: Postgres returns Dates, JSONB reorders keys. */
const normalize = (value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const hex = (value as { toHexString?: () => string }).toHexString;
    if (typeof hex === 'function') return hex.call(value);
    return Object.fromEntries(Object.keys(value as object).sort()
      .map((key) => [key, normalize((value as Doc)[key])]));
  }
  return value;
};
const differingFields = (expected: Row, actual: Row): string[] => Object.keys(expected)
  .filter((key) => JSON.stringify(normalize(expected[key])) !== JSON.stringify(normalize(actual[key])));

const MARKERS = ['__v', 'pgVersion', 'pgPending', 'pgDeleted'];
const plain = (doc: Doc | null): Doc | null => {
  if (!doc) return null;
  const out = { ...doc };
  MARKERS.forEach((key) => { delete out[key]; });
  return out;
};

const FLAG_CACHE_MS = 5000;
const PG_UPDATE_ATTEMPTS = 5;
const UPSERT_ATTEMPTS = 5;

const checkBatchSize = (batchSize: number): void => {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`dual-store: batchSize must be a positive integer, got ${String(batchSize)}`);
  }
};

/** findOneAndUpdate with includeResultMetadata: the driver's raw result. */
type RawResult = { value?: unknown; lastErrorObject?: { updatedExisting?: boolean } } | null;

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

interface DualStoreOptions {
  name: string;
  model: Model<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  pg: PgAdapter;
  /** Mongo document → Postgres row, including the id column. */
  toRow: (doc: Doc) => Row;
  /** Postgres row → the plain document a Mongo read returns, so reads keep one shape across modes. */
  fromRow: (row: Row) => Doc;
  /** Share of dual reads also compared against Postgres. */
  sampleRate?: number;
  /**
   * UNSAFE until deletes are tombstones in both stores (see the header): lets
   * `remove` run in dual, pg-read and pg. Off by default, so `remove` throws there.
   */
  allowDeletes?: boolean;
}

export interface DualStore {
  create(doc: Doc): Promise<Doc>;
  /** `undefined` unsets a field. Null when there is no such document. */
  update(id: Id, fields: Doc): Promise<Doc | null>;
  /** False when there was no such document. */
  remove(id: Id): Promise<boolean>;
  findById(id: Id): Promise<Doc | null>;
  /**
   * Atomic create-or-change of one document. `pipeline` is the change as Mongo
   * update-pipeline stages, applied to the stored document or, on a first
   * write, to `{ _id }` alone; `merge` is the same change in JS, applied to
   * the plain current document or null, and used where Postgres is the store.
   * The two must agree; a model that adopts this tests that they do. Values
   * inside `pipeline` are not cast by the schema, so the caller casts them.
   */
  upsert(id: Id, change: { pipeline: Doc[]; merge: (current: Doc | null) => Doc }): Promise<Doc>;
  /**
   * Atomic insert-if-absent: Mongo's `$setOnInsert` upsert. `filter` is a key
   * a unique index enforces; `fields` is the new document. Only an insert
   * writes, so only an insert takes a version (1) and is copied, and a call
   * that finds the document changes nothing. Two inserts racing past the
   * unique index can make the loser throw a duplicate-key error (code 11000):
   * it propagates, because losing that race is the caller's to read. A
   * document marked deleted is not replaced; the insert fails the same way.
   * Refused in pg mode until step 4.
   */
  insertIfAbsent(filter: Doc, fields: Doc): Promise<{ inserted: boolean }>;
  /**
   * Atomic conditional change of the one document `filter` matches, never an
   * insert: `$set` semantics for `fields`, dotted paths allowed. True when a
   * document matched and changed; only a match takes a version. In dual and
   * pg-read the change is an update pipeline, whose values the schema does not
   * cast, so the caller passes cast values (as for `upsert`). Refused in pg
   * mode until step 4.
   */
  setWhere(filter: Doc, fields: Doc): Promise<boolean>;
  repair(options?: { limit?: number }): Promise<{ scanned: number; copied: number; deleted: number; failed: number }>;
  /** Step 2's history copy. Dual or pg-read only. */
  backfill(options?: { dryRun?: boolean; batchSize?: number }): Promise<BackfillCounts>;
  /** Every live document against its row. Dual or pg-read only. */
  verify(options?: { batchSize?: number }): Promise<VerifyCounts>;
}

export interface BackfillCounts {
  scanned: number; inserted: number; alreadyCurrent: number;
  /** Pending when scanned, so copied in the final pass; their outcomes are in inserted and alreadyCurrent. */
  deferredPending: number;
}
export interface VerifyCounts {
  mongo: number; pg: number; missing: number; differs: number; extra: number;
  checksumMongo: string; checksumPg: string;
}

export function createDualStore(
  {
    name, model: Model, pg, toRow, fromRow, sampleRate = 0.1, allowDeletes = false,
  }: DualStoreOptions,
): DualStore {
  // Without the plugin, strict mode drops pgVersion and pgPending on write, so a
  // failed copy would never be flagged and repair would never see it.
  if (!Model.schema.path('pgVersion') || !Model.schema.path('pgPending')) {
    throw new Error(`dual-store: apply dualStorePlugin to the ${name} schema`);
  }
  /** A document marked pgDeleted reads as absent in every mode. */
  const alive = (id: Id) => ({ _id: id, pgDeleted: { $ne: true } });
  let flagged: { value: boolean; at: number } | null = null;

  const splitFields = (fields: Doc) => {
    const unset = Object.keys(fields).filter((key) => fields[key] === undefined);
    const toSet = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    return { unset, set: Model.castObject(toSet) as Doc };
  };
  const bump = { pgVersion: { $add: [{ $ifNull: ['$pgVersion', 0] }, 1] } };
  const markPending = { $set: { pgPending: '$pgVersion' } };

  /** True while any document is flagged. Never trusted across a restart: a new instance asks Mongo. */
  const anyFlagged = async (): Promise<boolean> => {
    if (flagged && Date.now() - flagged.at < FLAG_CACHE_MS) return flagged.value;
    const value = Boolean(await Model.exists({ pgPending: { $exists: true } }));
    flagged = { value, at: Date.now() };
    return value;
  };

  /**
   * Copies one committed write and clears its marker by version. A clear that
   * matches nothing lost to a later write, or to a delete; after a delete the
   * late upsert may have re-created the row, so its own version is removed.
   */
  const finishCopy = async (id: Id, version: number, row: Row, countFailure = true): Promise<boolean> => {
    try {
      if (!await pg.upsert(row, version)) {
        // Postgres already holds this version or a newer one. A newer Mongo
        // write explains that. Postgres read first, so a version above Mongo's
        // latest is one Mongo never wrote: keep the marker, so pg-read stays
        // on Mongo, and say so.
        const inPg = await pg.get(String(id));
        const latest = await Model.findById(id, { pgVersion: 1 }).lean() as Doc | null;
        if (inPg && latest && inPg.version > Number(latest.pgVersion ?? 0)) {
          if (countFailure) mismatch(name, id, 'pg-ahead');
          flagged = { value: true, at: Date.now() };
          return false;
        }
      }
    } catch {
      if (countFailure) mismatch(name, id, 'pg-write-failed');
      flagged = { value: true, at: Date.now() };
      return false;
    }
    const cleared = await Model.updateOne({ _id: id, pgPending: version }, { $unset: { pgPending: 1 } });
    if (cleared.matchedCount === 0) {
      const now = await Model.findById(id, { pgDeleted: 1 }).lean() as Doc | null;
      if (!now || now.pgDeleted) {
        // A still-flagged delete is finished by repair; a finished one leaves only this log line.
        await pg.remove(String(id), version + 1).catch((error: Error) => {
          console.warn(`[dual-store] late-row cleanup failed model=${name}:`, error.message);
        });
      }
    }
    return true;
  };

  const readMongo = async (id: Id, compare: boolean): Promise<Doc | null> => {
    const doc = await Model.findOne(alive(id)).lean() as Doc | null;
    if (doc && compare && doc.pgPending == null && Math.random() < sampleRate) {
      try {
        const got = await pg.get(String(id));
        if (!got) mismatch(name, id, 'missing');
        else {
          const fields = differingFields(toRow(doc), got.row);
          if (fields.length) mismatch(name, id, 'differs', fields);
        }
      } catch (error) {
        console.warn(`[dual-store] compare read failed model=${name}:`, (error as Error).message);
      }
    }
    return plain(doc);
  };

  // Step 4 gives these a single-statement Postgres form; until then pg mode refuses them.
  const notYetInPg = (method: string) => new Error(`dual-store: ${name} ${method} is not supported in pg mode`
    + ' until step 4 (docs/runbooks/adr-034-model-move.md)');

  const pgOnly = {
    async create(doc: Doc): Promise<Doc> {
      const casted = plain(new Model(doc).toObject() as Doc) as Doc;
      const row = toRow(casted);
      if (!await pg.upsert(row, 1)) throw new Error(`dual-store: ${name} ${String(casted._id)} already exists`);
      return fromRow(row);
    },
    async update(id: Id, fields: Doc): Promise<Doc | null> {
      const { set, unset } = splitFields(fields);
      for (let attempt = 0; attempt < PG_UPDATE_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- read-modify-write, retried on a lost race
        const got = await pg.get(String(id));
        if (!got) return null;
        const merged: Doc = { ...fromRow(got.row), ...set };
        unset.forEach((key) => { delete merged[key]; });
        const row = toRow(merged);
        // Only onto the version just read: a row deleted or rewritten since is
        // read again, so an update never re-creates a deleted row.
        // eslint-disable-next-line no-await-in-loop
        if (await pg.replace(row, got.version)) return fromRow(row);
      }
      throw new Error(`dual-store: ${name} update lost ${PG_UPDATE_ATTEMPTS} races in a row`);
    },
    async remove(id: Id): Promise<boolean> {
      for (let attempt = 0; attempt < PG_UPDATE_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- read-then-delete, retried on a lost race
        const got = await pg.get(String(id));
        if (!got) return false;
        // eslint-disable-next-line no-await-in-loop
        if (await pg.removeAt(String(id), got.version)) return true;
      }
      throw new Error(`dual-store: ${name} delete lost ${PG_UPDATE_ATTEMPTS} races in a row`);
    },
    async upsert(id: Id, merge: (current: Doc | null) => Doc): Promise<Doc> {
      for (let attempt = 0; attempt < PG_UPDATE_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- read-modify-write, retried on a lost race
        const got = await pg.get(String(id));
        const row = toRow({ ...merge(got ? fromRow(got.row) : null), _id: id });
        // A first write inserts at version 1 and loses to any row that appeared
        // since the read; a later one applies only onto the version it read.
        // Either way a lost race reads again.
        // eslint-disable-next-line no-await-in-loop
        if (got ? await pg.replace(row, got.version) : await pg.upsert(row, 1)) return fromRow(row);
      }
      throw new Error(`dual-store: ${name} upsert lost ${PG_UPDATE_ATTEMPTS} races in a row`);
    },
  };

  return {
    async create(doc) {
      const mode = storeMode(name);
      if (mode === 'pg') return pgOnly.create(doc);
      if (mode === 'mongo') return plain((await Model.create(doc)).toObject() as Doc) as Doc;
      const created = (await Model.create({ ...doc, pgVersion: 1, pgPending: 1 })).toObject() as Doc;
      await finishCopy(created._id, 1, toRow(created));
      return plain(created) as Doc;
    },

    async update(id, fields) {
      const mode = storeMode(name);
      if (mode === 'pg') return pgOnly.update(id, fields);
      const { set, unset } = splitFields(fields);
      if (mode === 'mongo') {
        const update: Doc = { $set: set };
        if (unset.length) update.$unset = Object.fromEntries(unset.map((key) => [key, 1]));
        return plain(await Model.findOneAndUpdate(alive(id), update, { new: true }).lean() as Doc | null);
      }
      // One atomic pipeline update: the fields, the version and the marker.
      // $literal keeps a value like "$5 off" from being read as a field path.
      const literal = Object.fromEntries(Object.entries(set).map(([key, value]) => [key, { $literal: value }]));
      const pipeline: Doc[] = [{ $set: { ...literal, ...bump } }, markPending];
      if (unset.length) pipeline.push({ $unset: unset });
      const doc = await Model.findOneAndUpdate(alive(id), pipeline, { new: true }).lean() as Doc | null;
      if (!doc) return null;
      await finishCopy(doc._id, doc.pgVersion as number, toRow(doc));
      return plain(doc);
    },

    async remove(id) {
      const mode = storeMode(name);
      if (mode === 'mongo') return (await Model.deleteOne(alive(id))).deletedCount > 0;
      if (!allowDeletes) {
        throw new Error(`dual-store: ${name} refuses remove in ${mode}: deletes need tombstones in both stores`
          + ' (docs/runbooks/adr-034-model-move.md)');
      }
      if (mode === 'pg') return pgOnly.remove(id);
      // Two-phase: mark, remove the row, then the document. A crash between
      // any two steps leaves a flagged pgDeleted document for repair.
      const marked = await Model.findOneAndUpdate(
        alive(id), [{ $set: { pgDeleted: true, ...bump } }, markPending], { new: true },
      ).lean() as Doc | null;
      if (!marked) return false;
      const version = marked.pgVersion as number;
      try {
        await pg.remove(String(marked._id), version);
      } catch {
        mismatch(name, marked._id, 'pg-write-failed');
        flagged = { value: true, at: Date.now() };
        return true;
      }
      await Model.deleteOne({ _id: marked._id, pgPending: version });
      return true;
    },

    async upsert(id, { pipeline, merge }) {
      const mode = storeMode(name);
      if (mode === 'pg') return pgOnly.upsert(id, merge);
      // dual and pg-read: the change, the version and the marker in one atomic write.
      const stages = mode === 'mongo' ? pipeline : [...pipeline, { $set: bump }, markPending];
      let doc: Doc | null = null;
      for (let attempt = 0; attempt < UPSERT_ATTEMPTS && !doc; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop -- retried only on a lost first-write race
          doc = await Model.findOneAndUpdate(alive(id), stages, { upsert: true, new: true }).lean() as Doc | null;
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          // The _id exists, but the alive filter did not match it on the way in.
          // Either two first writes raced, and the loser applies onto the
          // winner without an upsert, or the document is marked deleted.
          // eslint-disable-next-line no-await-in-loop
          doc = await Model.findOneAndUpdate(alive(id), stages, { new: true }).lean() as Doc | null;
          if (!doc) {
            // A write onto a document mid-delete is ordered after the delete:
            // it starts from an empty document, exactly as a first write does,
            // and nothing of the deleted one comes back. Its version continues
            // above the delete's, so the delete's late Postgres remove cannot
            // take the new row, and the delete's final conditional deleteOne
            // no longer matches. pgVersion is kept only for that ordering.
            // eslint-disable-next-line no-await-in-loop
            doc = await Model.findOneAndUpdate(
              { _id: id, pgDeleted: true },
              [{ $replaceWith: { _id: '$_id', pgVersion: '$pgVersion' } }, ...stages],
              { new: true },
            ).lean() as Doc | null;
          }
        }
      }
      if (!doc) throw new Error(`dual-store: ${name} upsert lost ${UPSERT_ATTEMPTS} races in a row`);
      if (mode !== 'mongo') await finishCopy(doc._id, doc.pgVersion as number, toRow(doc));
      return plain(doc) as Doc;
    },

    async insertIfAbsent(filter, fields) {
      const mode = storeMode(name);
      if (mode === 'pg') throw notYetInPg('insertIfAbsent');
      const options = {
        upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true,
      };
      if (mode === 'mongo') {
        const result = await Model.findOneAndUpdate(
          filter, { $setOnInsert: fields }, { ...options, new: false },
        ) as unknown as RawResult;
        return { inserted: !(result?.lastErrorObject?.updatedExisting === true || result?.value != null) };
      }
      // The version and the marker ride in $setOnInsert, so a call that finds
      // the document writes nothing and bumps nothing. Not lean: a lean query
      // drops the result metadata that says whether this call inserted.
      const result = await Model.findOneAndUpdate(
        { ...filter, pgDeleted: { $ne: true } },
        { $setOnInsert: { ...fields, pgVersion: 1, pgPending: 1 } },
        { ...options, new: true },
      ) as unknown as RawResult;
      if (result?.lastErrorObject?.updatedExisting !== false || !result.value) return { inserted: false };
      // The plain shape a lean read returns (a Map as an object), which toRow expects.
      const doc = (result.value as { toObject: (o: object) => Doc }).toObject({ flattenMaps: true });
      await finishCopy(doc._id, doc.pgVersion as number, toRow(doc));
      return { inserted: true };
    },

    async setWhere(filter, fields) {
      const mode = storeMode(name);
      if (mode === 'pg') throw notYetInPg('setWhere');
      const paths = Object.keys(fields);
      if (paths.some((path) => path.split('.').some((part) => !part || part.startsWith('$')))) {
        throw new Error(`dual-store: ${name} setWhere path must not be empty or start with $`);
      }
      if (mode === 'mongo') {
        const result = await Model.findOneAndUpdate(
          filter, { $set: fields }, { new: false, includeResultMetadata: true },
        ) as unknown as RawResult;
        return result?.value != null;
      }
      // One atomic pipeline update: the fields, the version and the marker.
      const literal = Object.fromEntries(paths.map((path) => [path, { $literal: fields[path] }]));
      const doc = await Model.findOneAndUpdate(
        { ...filter, pgDeleted: { $ne: true } }, [{ $set: { ...literal, ...bump } }, markPending], { new: true },
      ).lean() as Doc | null;
      if (!doc) return false;
      await finishCopy(doc._id, doc.pgVersion as number, toRow(doc));
      return true;
    },

    async findById(id) {
      const mode = storeMode(name);
      if (mode === 'mongo') return readMongo(id, false);
      if (mode === 'dual') return readMongo(id, true);
      if (mode === 'pg-read') {
        let mongoFirst = false;
        try {
          mongoFirst = await anyFlagged();
        } catch (error) {
          // The flag check is Mongo's. With Mongo down a pg-read still reads its
          // row, which is as current as the last copy that reached it.
          console.warn(`[dual-store] flag check failed model=${name}; reading Postgres:`, (error as Error).message);
        }
        if (mongoFirst) return readMongo(id, true);
      }
      const got = await pg.get(String(id));
      return got ? fromRow(got.row) : null;
    },

    async repair({ limit = 100 } = {}) {
      const counts = {
        scanned: 0, copied: 0, deleted: 0, failed: 0,
      };
      const mode = storeMode(name);
      if (mode === 'mongo' || mode === 'pg') return counts;
      const docs = await Model.find({ pgPending: { $exists: true } }).limit(limit).lean() as Doc[];
      for (const doc of docs) {
        counts.scanned += 1;
        const version = doc.pgPending as number;
        if (doc.pgDeleted) {
          try {
            // eslint-disable-next-line no-await-in-loop -- one document at a time keeps the order
            await pg.remove(String(doc._id), version);
            // eslint-disable-next-line no-await-in-loop
            await Model.deleteOne({ _id: doc._id, pgPending: version });
            counts.deleted += 1;
          } catch {
            counts.failed += 1;
          }
        // eslint-disable-next-line no-await-in-loop
        } else if (await finishCopy(doc._id, version, toRow(doc), false)) {
          counts.copied += 1;
        } else {
          counts.failed += 1;
        }
      }
      flagged = null;
      return counts;
    },

    async backfill({ dryRun = true, batchSize = 500 } = {}) {
      checkBatchSize(batchSize);
      const mode = storeMode(name);
      // Dual must already be on, on every replica, before this runs. A mongo-mode
      // write changes a document without bumping pgVersion or touching
      // Postgres, so a row this copies at version v would go stale under it,
      // and no later copy at the same v could fix it (the adapter refuses a
      // version it already holds). In dual, every write bumps the version and
      // copies itself, so it always beats this copy, whichever lands first.
      if (mode !== 'dual' && mode !== 'pg-read') {
        throw new Error(`dual-store: backfill needs ${modeEnvName(name)}=dual or pg-read, not ${mode}`);
      }
      const counts: BackfillCounts = {
        scanned: 0, inserted: 0, alreadyCurrent: 0, deferredPending: 0,
      };
      const cursor = Model.find({ pgDeleted: { $ne: true } }).sort({ _id: 1 }).lean().cursor({ batchSize });
      const copy = async (doc: Doc) => {
        const version = Number(doc.pgVersion ?? 0);
        let applied: boolean;
        if (dryRun) {
          const got = await pg.get(String(doc._id));
          applied = !got || got.version < version;
        } else {
          applied = await pg.upsert(toRow(doc), version);
        }
        if (applied) counts.inserted += 1;
        else counts.alreadyCurrent += 1;
      };
      const pending: Id[] = [];
      for await (const doc of cursor as AsyncIterable<Doc>) {
        counts.scanned += 1;
        // A flagged document's own copy is in flight or failed: deferred to the end.
        if (doc.pgPending != null) pending.push(doc._id);
        else await copy(doc);
      }
      // A write in flight when the scan passed it may have copied its row
      // before the table was emptied and clear its marker at any point after,
      // even after this pass, which would leave an unflagged document with no
      // row that repair never sees. So each deferred document is read again and
      // copied now, pending or not, at its current version: the copy is
      // version-guarded, so a newer write still wins, and the in-flight copy
      // lands at the same version or is a no-op.
      for (const docId of pending) {
        // eslint-disable-next-line no-await-in-loop -- a handful, in order
        const doc = await Model.findOne(alive(docId)).lean() as Doc | null;
        if (doc) {
          counts.deferredPending += 1;
          // eslint-disable-next-line no-await-in-loop
          await copy(doc);
        }
      }
      return counts;
    },

    async verify({ batchSize = 500 } = {}) {
      checkBatchSize(batchSize);
      const mode = storeMode(name);
      if (mode !== 'dual' && mode !== 'pg-read') {
        throw new Error(`dual-store: verify needs ${modeEnvName(name)}=dual or pg-read, not ${mode}`);
      }
      // Holds one normalised row per document, so it is sized for the small
      // models moved first; a large model would page both sides in id order.
      // `toRow` must emit exactly the table's columns, or the checksums differ
      // even where the field compare (the sampled compare's) finds nothing.
      const line = (row: Row) => JSON.stringify(normalize(row));
      const mongoRows = new Map<string, Row>();
      const mongoVersions = new Map<string, number>();
      const cursor = Model.find({ pgDeleted: { $ne: true } }).lean().cursor({ batchSize });
      for await (const doc of cursor as AsyncIterable<Doc>) {
        mongoRows.set(String(doc._id), toRow(doc));
        mongoVersions.set(String(doc._id), Number(doc.pgVersion ?? 0));
      }
      const counts = {
        mongo: mongoRows.size, pg: 0, missing: 0, differs: 0, extra: 0,
      };
      const report = (rowId: string, kind: string, fields: string[] = []) => {
        const listed = fields.length ? ` fields=${fields.join(',')}` : '';
        console.warn(`[dual-store] verify model=${name} id=${hashId(rowId)} kind=${kind}${listed}`);
      };
      const pgLines: string[] = [];
      const seen = new Set<string>();
      let after: string | null = null;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- keyset paging
        const page = await pg.scan(after, batchSize);
        if (!page.length) break;
        for (const { id: rowId, row, version } of page) {
          counts.pg += 1;
          pgLines.push(line(row));
          const expected = mongoRows.get(rowId);
          if (!expected) {
            counts.extra += 1;
            report(rowId, 'extra');
          } else {
            seen.add(rowId);
            const fields = differingFields(expected, row);
            // Equal payloads at different versions still differ: the next
            // copy's version guard would then keep or drop the wrong row.
            if (version !== mongoVersions.get(rowId)) fields.push('pgVersion');
            if (fields.length) {
              counts.differs += 1;
              report(rowId, 'differs', fields);
            }
          }
        }
        after = page[page.length - 1].id;
      }
      mongoRows.forEach((_, docId) => {
        if (!seen.has(docId)) {
          counts.missing += 1;
          report(docId, 'missing');
        }
      });
      const checksum = (lines: string[]) => createHash('sha256').update(lines.sort().join('\n')).digest('hex');
      return {
        ...counts,
        checksumMongo: checksum([...mongoRows.values()].map(line)),
        checksumPg: checksum(pgLines),
      };
    },
  };
}
