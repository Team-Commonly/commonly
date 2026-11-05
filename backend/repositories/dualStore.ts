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
 */
import { createHash } from 'crypto';
import type { Model, Schema } from 'mongoose';

export type StoreMode = 'mongo' | 'dual' | 'pg-read' | 'pg';
const MODES: readonly StoreMode[] = ['mongo', 'dual', 'pg-read', 'pg'];

type Doc = Record<string, unknown>;
type Row = Record<string, unknown>;
type Id = unknown;

/** What the helper needs from a Postgres table. Rows carry their id column. */
export interface PgAdapter {
  /** Writes the row unless the stored one is at `version` or newer; true when applied. */
  upsert(row: Row, version: number): Promise<boolean>;
  /** Deletes the row unless the stored one is at `version` or newer. */
  remove(id: string, version: number): Promise<void>;
  /** pg mode: writes the row at `version + 1` only if it is still at `version`; true when applied. */
  replace(row: Row, version: number): Promise<boolean>;
  /** pg mode: deletes the row only if it is still at `version`; true when deleted. */
  removeAt(id: string, version: number): Promise<boolean>;
  get(id: string): Promise<{ row: Row; version: number } | null>;
  /** Rows after `afterId` in id order (text order), `limit` at a time; verify walks it for rows Mongo lacks. */
  list?(afterId: string | null, limit: number): Promise<{ row: Row; version: number }[]>;
}

interface PgQueryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;
}

const warnedModes = new Set<string>();

export const modeEnvName = (name: string): string => `STORE_MODE_${name
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
 */
export function pgTableAdapter(
  {
    pool, table, idColumn, columns, jsonColumns = [],
  }: { pool: PgQueryable; table: string; idColumn: string; columns: string[]; jsonColumns?: string[] },
): PgAdapter {
  const t = identifier(table);
  const id = identifier(idColumn);
  const cols = columns.map(identifier);
  const json = new Set(jsonColumns.map(identifier));
  if ([...json].some((c) => !cols.includes(c))) throw new Error('dual-store: jsonColumns must be listed in columns');
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
      return { row, version: Number(version) };
    },
    async list(afterId, limit) {
      const { rows } = afterId == null
        ? await pool.query(`SELECT ${all.join(', ')}, pg_version FROM ${t} ORDER BY ${id}::text LIMIT $1`, [limit])
        : await pool.query(`SELECT ${all.join(', ')}, pg_version FROM ${t} WHERE ${id}::text > $1
          ORDER BY ${id}::text LIMIT $2`, [afterId, limit]);
      return rows.map(({ pg_version: version, ...row }) => ({ row, version: Number(version) }));
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

/** Never logs a value or a raw id: only the model, a hashed id, and field names. */
function mismatch(name: string, id: Id, kind: MismatchKind, fields: string[] = []): void {
  const current = dualStoreStats(name);
  current[kind] += 1;
  stats.set(name, current);
  const hashed = createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
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

/**
 * The update operators the helper writes in every mode. Wave 1's callers use
 * these and no others (measured 2026-11-05); an operator outside the set is
 * refused by name, never dropped, so a new caller finds out in its first test.
 */
const OPERATORS = new Set(['$set', '$unset', '$inc', '$max', '$min', '$push', '$setOnInsert']);
export type UpdateOperators = Partial<Record<'$set' | '$unset' | '$inc' | '$max' | '$min' | '$push' | '$setOnInsert', Doc>>;

const checkOperators = (update: Doc): void => {
  for (const [op, fields] of Object.entries(update)) {
    if (!op.startsWith('$')) throw new Error(`dual-store: an update takes operators ($set, $inc, ...), got "${op}"`);
    if (!OPERATORS.has(op)) throw new Error(`dual-store: ${op} is not supported`);
    if (op === '$push') {
      for (const value of Object.values(fields as Doc)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).some((k) => k.startsWith('$'))) {
          const extra = Object.keys(value).find((k) => k !== '$each');
          if (extra) throw new Error(`dual-store: $push ${extra} is not supported`);
        }
      }
    }
  }
};

const pushedItems = (value: unknown): unknown[] => (
  value && typeof value === 'object' && !Array.isArray(value) && '$each' in (value as Doc)
    ? [...((value as Doc).$each as unknown[])]
    : [value]
);

/** A deep copy that keeps Dates, ObjectIds and other class instances as they are. */
const cloneDoc = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneDoc);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value as Doc).map(([k, v]) => [k, cloneDoc(v)]));
  }
  return value;
};
const getPath = (doc: Doc, path: string): unknown => path.split('.')
  .reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Doc)[key] : undefined), doc);
const setPath = (doc: Doc, path: string, value: unknown): void => {
  const keys = path.split('.');
  let at = doc;
  keys.slice(0, -1).forEach((key) => {
    if (!at[key] || typeof at[key] !== 'object') at[key] = {};
    at = at[key] as Doc;
  });
  at[keys[keys.length - 1]] = value;
};
const unsetPath = (doc: Doc, path: string): void => {
  const keys = path.split('.');
  const parent = keys.length > 1 ? getPath(doc, keys.slice(0, -1).join('.')) : doc;
  if (parent && typeof parent === 'object') delete (parent as Doc)[keys[keys.length - 1]];
};

/**
 * Applies an update to a plain document in process, the way Mongo would. pg
 * mode writes this way (read, apply, compare-and-set), so its result has to be
 * Mongo's; the shared tests hold the two to the same answers.
 */
export function applyUpdateOperators(doc: Doc, update: Doc, { inserting = false } = {}): Doc {
  checkOperators(update);
  const out = cloneDoc(doc) as Doc;
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields as Doc)) {
      const current = getPath(out, path);
      if (op === '$set') setPath(out, path, cloneDoc(value));
      else if (op === '$setOnInsert') { if (inserting) setPath(out, path, cloneDoc(value)); }
      else if (op === '$unset') unsetPath(out, path);
      else if (op === '$inc') setPath(out, path, Number(current ?? 0) + Number(value));
      else if (op === '$max') { if (current == null || (value as number) > (current as number)) setPath(out, path, value); }
      else if (op === '$min') { if (current == null || (value as number) < (current as number)) setPath(out, path, value); }
      else if (op === '$push') setPath(out, path, [...(Array.isArray(current) ? current : []), ...pushedItems(value)]);
    }
  }
  return out;
}

/**
 * The same update as one Mongo pipeline stage list, so the fields, the version
 * bump and the marker land in one atomic write. `$literal` keeps a value like
 * "$5 off" from being read as a field path.
 */
const toPipeline = (update: Doc, extraSet: Doc): Doc[] => {
  checkOperators(update);
  const set: Doc = {};
  const unset: string[] = [];
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields as Doc)) {
      const ref = `$${path}`;
      if (op === '$set') set[path] = { $literal: value };
      else if (op === '$unset') unset.push(path);
      else if (op === '$inc') set[path] = { $add: [{ $ifNull: [ref, 0] }, value] };
      // The aggregation $max/$min skip a missing or null operand, as the update operators do.
      else if (op === '$max') set[path] = { $max: [ref, { $literal: value }] };
      else if (op === '$min') set[path] = { $min: [ref, { $literal: value }] };
      else if (op === '$push') set[path] = { $concatArrays: [{ $ifNull: [ref, []] }, { $literal: pushedItems(value) }] };
      // $setOnInsert touches an existing document not at all.
    }
  }
  const pipeline: Doc[] = [{ $set: { ...set, ...extraSet } }];
  if (unset.length) pipeline.push({ $unset: unset });
  return pipeline;
};

/** The equality fields of a filter: what an upsert's new document starts from. */
const insertBase = (filter: Doc): Doc => Object.fromEntries(Object.entries(filter).filter(([key, value]) => (
  !key.startsWith('$')
  && !(value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    && typeof (value as { toHexString?: unknown }).toHexString !== 'function'
    && Object.keys(value).some((k) => k.startsWith('$')))
)));

/** A filter-scoped read: the Mongo filter, and the same question as a Postgres query. */
export interface FilterRead {
  mongo: Doc;
  /** Rows (with the id column) answering the same filter; required in pg and pg-read modes. */
  pg?: () => Promise<Row[]>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
}
/** pg mode has no Mongo to filter, so a filter write names its Postgres rows. */
export interface FilterWriteOptions {
  pg?: () => Promise<Row[]>;
}

export interface VerifyReport {
  checked: number;
  /** Documents still flagged; repair finishes them, and a read cut waits for zero. */
  pending: number;
  missing: string[];
  differs: { id: string; fields: string[] }[];
  pgOnly: string[];
}

export interface DualStoreOptions {
  name: string;
  model: Model<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  pg: PgAdapter;
  /** Mongo document → Postgres row, including the id column. */
  toRow: (doc: Doc) => Row;
  /** Postgres row → the plain document a Mongo read returns, so reads keep one shape across modes. */
  fromRow: (row: Row) => Doc;
  /** Share of dual reads also compared against Postgres. */
  sampleRate?: number;
}

export interface DualStore {
  create(doc: Doc): Promise<Doc>;
  /** `undefined` unsets a field. Null when there is no such document. */
  update(id: Id, fields: Doc): Promise<Doc | null>;
  /** False when there was no such document. */
  remove(id: Id): Promise<boolean>;
  findById(id: Id): Promise<Doc | null>;
  repair(options?: { limit?: number }): Promise<{ scanned: number; copied: number; deleted: number; failed: number }>;
  find(read: FilterRead): Promise<Doc[]>;
  findOne(read: FilterRead): Promise<Doc | null>;
  /** findOneAndUpdate with `new: true`. With `upsert`, inserts from the filter's equality fields. */
  updateOne(filter: Doc, update: Doc, options?: FilterWriteOptions & { upsert?: boolean }): Promise<Doc | null>;
  updateMany(filter: Doc, update: Doc, options?: FilterWriteOptions): Promise<{ matched: number }>;
  deleteOne(filter: Doc, options?: FilterWriteOptions): Promise<{ deleted: number }>;
  deleteMany(filter: Doc, options?: FilterWriteOptions): Promise<{ deleted: number }>;
  /** Copies every live Mongo document to Postgres through the marker. The first step after `dual`. */
  backfill(options?: { batch?: number }): Promise<{ scanned: number; copied: number; failed: number }>;
  /** The read-cut gate (ADR-034 D3): every mismatch between the stores, named. */
  verify(options?: { batch?: number; maxIds?: number }): Promise<VerifyReport>;
}

export function createDualStore(
  { name, model: Model, pg, toRow, fromRow, sampleRate = 0.1 }: DualStoreOptions,
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
    /** An operator update on one row: read, apply in process, compare-and-set. */
    async apply(id: Id, update: Doc): Promise<Doc | null> {
      for (let attempt = 0; attempt < PG_UPDATE_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- read-modify-write, retried on a lost race
        const got = await pg.get(String(id));
        if (!got) return null;
        const row = toRow(applyUpdateOperators(fromRow(got.row), update));
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
  };

  /** A filter, restricted to documents not mid-delete. */
  const live = (filter: Doc): Doc => ({ $and: [filter, { pgDeleted: { $ne: true } }] });

  const selectPg = async (rows?: () => Promise<Row[]>): Promise<Row[]> => {
    if (typeof rows !== 'function') {
      throw new Error(`dual-store: ${name} reads Postgres in this mode, so the call must pass its Postgres query`);
    }
    return rows();
  };

  const find = async ({ mongo: filter, pg: pgRows, sort, limit }: FilterRead): Promise<Doc[]> => {
    const mode = storeMode(name);
    if (mode === 'pg' || (mode === 'pg-read' && !await anyFlagged())) {
      const rows = await selectPg(pgRows);
      return (limit ? rows.slice(0, limit) : rows).map(fromRow);
    }
    let query = Model.find(live(filter));
    if (sort) query = query.sort(sort);
    if (limit) query = query.limit(limit);
    const docs = await query.lean() as Doc[];
    if (mode !== 'mongo') {
      for (const doc of docs) {
        if (doc.pgPending == null && Math.random() < sampleRate) {
          try {
            // eslint-disable-next-line no-await-in-loop -- sampled, so few
            const got = await pg.get(String(doc._id));
            if (!got) mismatch(name, doc._id, 'missing');
            else {
              const fields = differingFields(toRow(doc), got.row);
              if (fields.length) mismatch(name, doc._id, 'differs', fields);
            }
          } catch (error) {
            console.warn(`[dual-store] compare read failed model=${name}:`, (error as Error).message);
          }
        }
      }
    }
    return docs.map((doc) => plain(doc) as Doc);
  };

  const deleteWhere = async (filter: Doc, { pg: pgRows }: FilterWriteOptions = {}, one = false) => {
    const mode = storeMode(name);
    if (mode === 'mongo') {
      return { deleted: (one ? await Model.deleteOne(filter) : await Model.deleteMany(filter)).deletedCount };
    }
    const targets = mode === 'pg'
      ? (await selectPg(pgRows)).map((row) => fromRow(row)._id)
      : (await Model.find(live(filter), { _id: 1 }).limit(one ? 1 : 0).lean() as Doc[]).map((d) => d._id);
    let deleted = 0;
    for (const id of one ? targets.slice(0, 1) : targets) {
      // eslint-disable-next-line no-await-in-loop -- each delete is two-phase
      if (await store.remove(id)) deleted += 1;
    }
    return { deleted };
  };

  const store: DualStore = {
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
      if (mode === 'pg') return pgOnly.remove(id);
      if (mode === 'mongo') return (await Model.deleteOne(alive(id))).deletedCount > 0;
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

    async findById(id) {
      const mode = storeMode(name);
      if (mode === 'mongo') return readMongo(id, false);
      if (mode === 'dual') return readMongo(id, true);
      if (mode === 'pg-read' && await anyFlagged()) return readMongo(id, true);
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

    find: (read) => find(read),
    async findOne(read) {
      return (await find({ ...read, limit: 1 }))[0] ?? null;
    },

    async updateOne(filter, update, { upsert = false, pg: pgRows } = {}) {
      const mode = storeMode(name);
      if (mode === 'mongo') {
        return plain(await Model.findOneAndUpdate(filter, update, { new: true, upsert }).lean() as Doc | null);
      }
      if (mode === 'pg') {
        const [row] = await selectPg(pgRows);
        if (row) return pgOnly.apply(fromRow(row)._id, update);
        return upsert ? pgOnly.create(applyUpdateOperators(insertBase(filter), update, { inserting: true })) : null;
      }
      const pipeline = toPipeline(update, bump);
      for (let attempt = 0; attempt < PG_UPDATE_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- an upsert that lost a race retries as an update
        const doc = await Model.findOneAndUpdate(live(filter), [...pipeline, markPending], { new: true }).lean() as Doc | null;
        if (doc) {
          // eslint-disable-next-line no-await-in-loop
          await finishCopy(doc._id, doc.pgVersion as number, toRow(doc));
          return plain(doc);
        }
        if (!upsert) return null;
        try {
          // eslint-disable-next-line no-await-in-loop
          return await store.create(applyUpdateOperators(insertBase(filter), update, { inserting: true }));
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
        }
      }
      throw new Error(`dual-store: ${name} upsert lost ${PG_UPDATE_ATTEMPTS} races in a row`);
    },

    async updateMany(filter, update, { pg: pgRows } = {}) {
      const mode = storeMode(name);
      if (mode === 'mongo') return { matched: (await Model.updateMany(filter, update)).matchedCount };
      if (mode === 'pg') {
        const rows = await selectPg(pgRows);
        for (const row of rows) {
          // eslint-disable-next-line no-await-in-loop -- read-modify-write per row
          await pgOnly.apply(fromRow(row)._id, update);
        }
        return { matched: rows.length };
      }
      // The ids are fixed first, so the copies below finish exactly the
      // documents this write touched (and any a racing write left flagged,
      // which finishCopy settles by version either way).
      const targets = (await Model.find(live(filter), { _id: 1 }).lean() as Doc[]).map((d) => d._id);
      if (!targets.length) return { matched: 0 };
      const result = await Model.updateMany(
        { $and: [live(filter), { _id: { $in: targets } }] }, [...toPipeline(update, bump), markPending],
      );
      const flaggedDocs = await Model.find({ _id: { $in: targets }, pgPending: { $exists: true } }).lean() as Doc[];
      for (const doc of flaggedDocs) {
        // eslint-disable-next-line no-await-in-loop -- one copy at a time keeps the version order
        await finishCopy(doc._id, doc.pgPending as number, toRow(doc));
      }
      return { matched: result.matchedCount };
    },

    deleteOne: (filter, options) => deleteWhere(filter, options, true),
    deleteMany: (filter, options) => deleteWhere(filter, options, false),

    async backfill({ batch = 500 } = {}) {
      const counts = { scanned: 0, copied: 0, failed: 0 };
      const mode = storeMode(name);
      if (mode === 'mongo' || mode === 'pg') return counts;
      let after: Id = null;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- paged by _id
        const docs = await Model.find({ pgDeleted: { $ne: true }, ...(after != null && { _id: { $gt: after } }) })
          .sort({ _id: 1 }).limit(batch).lean() as Doc[];
        if (!docs.length) break;
        for (const doc of docs) {
          counts.scanned += 1;
          // A flagged document is finished at its own version; any other is
          // marked through the same atomic write a live update uses, so a
          // backfill racing a write can only copy a version Mongo holds.
          const marked = doc.pgPending != null ? doc
            // eslint-disable-next-line no-await-in-loop
            : await Model.findOneAndUpdate(
              { _id: doc._id, pgPending: { $exists: false }, pgDeleted: { $ne: true } },
              [{ $set: bump }, markPending], { new: true },
            ).lean() as Doc | null;
          if (!marked) { counts.copied += 1; continue; } // a live write took it and copies it itself
          // eslint-disable-next-line no-await-in-loop
          if (await finishCopy(marked._id, marked.pgPending as number, toRow(marked), false)) counts.copied += 1;
          else counts.failed += 1;
        }
        after = docs[docs.length - 1]._id;
      }
      flagged = null;
      return counts;
    },

    async verify({ batch = 500, maxIds = 50 } = {}) {
      const report: VerifyReport = {
        checked: 0, pending: 0, missing: [], differs: [], pgOnly: [],
      };
      const note = <T>(list: T[], item: T) => { if (list.length < maxIds) list.push(item); };
      let after: Id = null;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- paged by _id
        const docs = await Model.find(after != null ? { _id: { $gt: after } } : {})
          .sort({ _id: 1 }).limit(batch).lean() as Doc[];
        if (!docs.length) break;
        for (const doc of docs) {
          if (doc.pgPending != null) { report.pending += 1; continue; }
          report.checked += 1;
          // eslint-disable-next-line no-await-in-loop
          const got = await pg.get(String(doc._id));
          if (!got) note(report.missing, String(doc._id));
          else {
            const fields = differingFields(toRow(doc), got.row);
            if (fields.length) note(report.differs, { id: String(doc._id), fields });
          }
        }
        after = docs[docs.length - 1]._id;
      }
      if (!pg.list) throw new Error(`dual-store: ${name}'s Postgres adapter has no list(); verify needs it`);
      let afterRow: string | null = null;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- paged by id
        const rows = await pg.list(afterRow, batch);
        if (!rows.length) break;
        const rowIds = rows.map(({ row }) => fromRow(row)._id);
        // eslint-disable-next-line no-await-in-loop
        const inMongo = new Set((await Model.find({ _id: { $in: rowIds } }, { _id: 1 }).lean() as Doc[])
          .map((d) => String(d._id)));
        rowIds.forEach((rowId) => { if (!inMongo.has(String(rowId))) note(report.pgOnly, String(rowId)); });
        // The id column holds String(_id), so the last id resumes the walk.
        afterRow = String(rowIds[rowIds.length - 1]);
      }
      return report;
    },
  };
  return store;
}
