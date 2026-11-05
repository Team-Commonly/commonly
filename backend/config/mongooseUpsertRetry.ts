/**
 * Retry upserts that lost a race on a unique key, in one place — on FerretDB.
 *
 * MongoDB retries a duplicate-key upsert internally: 20 concurrent
 * `updateOne({k}, {$inc:{n:1}}, {upsert:true})` calls end as one document with
 * n=20. FerretDB (the Postgres-backed Mongo layer self-hosted Commonly can run
 * on) surfaces the same race to the client, and the run ends at n=15 with
 * five throws: E11000 or a Postgres deadlock (16908292) from updateOne, and
 * code 1 InternalError "violates exclusion constraint" or "deadlock detected"
 * from findOneAndUpdate (measured on FerretDB 2.7). At boot that took down
 * heartbeat dispatch. Rather than wrap each of the backend's upsert call
 * sites, this wraps `Query.prototype.exec` and `Model.bulkWrite` once.
 *
 * The retry is OFF unless the server is FerretDB. On MongoDB an upsert E11000
 * means Mongo's own internal retry already lost, so ours would only add round
 * trips and sleeps to every routine lease or claim loser (the scheduler and
 * account-deletion leases each tick, the per-seat wake reservation in a serial
 * sweep). Precedence: env MONGO_UPSERT_RETRY (1/true or 0/false) wins; then an
 * explicit enableUpsertRetry()/disableUpsertRetry(); then detection, which
 * reads buildInfo on each default-connection open (FerretDB adds a `ferretdb`
 * field). Off, the wrapper costs one flag check per query.
 *
 * Retrying is safe because a failed upsert attempt applied nothing: the
 * insert-or-update is a single document write that either commits or errors,
 * and every one of those errors is raised before it commits. The retry
 * re-reads the filter and lands on the row the winner inserted, exactly as
 * MongoDB's own retry does. That is why updateMany is NOT retried (it can
 * apply to some documents and then fail, and a replay double-applies $inc),
 * and why nothing inside a transaction is retried (the error aborted the
 * transaction; the caller owns its retry).
 *
 * Each attempt is a full Mongoose execution: pre hooks with outside side
 * effects and error-handling post hooks fire once per attempt, not once.
 *
 * Only upserts are retried. An E11000 from a plain update or insert is a real
 * uniqueness violation and must surface on its first throw. An upsert whose
 * conflict is real (its filter can never match the row holding the key) still
 * surfaces, after the bounded retries. Callers should test it with
 * utils/duplicateKeyError, which knows both forms.
 *
 * Registered from config/db (the server) and __tests__/utils/testUtils (the
 * harness). One-off scripts that call mongoose.connect() themselves are not
 * covered unless they require this.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const defaultMongoose = require('mongoose');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isDuplicateKeyError, DUPLICATE_KEY_CODE } = require('../utils/duplicateKeyError');

const MAX_UPSERT_ATTEMPTS = 5;
// No new attempt starts once this long has passed since the first began. A
// lost race resolves in tens of ms; under contention FerretDB can instead
// stall a single attempt for 16-19s (measured on 2.7, with or without this
// wrapper) and then fail it. Retrying that four more times turned one stall
// into ~90s. With the cap a stall costs about one stall, then surfaces.
const UPSERT_RETRY_BUDGET_MS = 2000;
// FerretDB's code for a Postgres deadlock (SQLSTATE 40P01) between two upserts.
const FERRETDB_DEADLOCK_CODE = 16908292;
// Single-document writes only: each attempt applies all or nothing.
const UPSERT_OPS = new Set(['updateOne', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']);
// A bulkWrite can fail after earlier ops applied (ordered) or around them
// (unordered), so a retry re-runs ops that already landed. That is only safe
// when re-running is a no-op: operators that set a value, never ones that
// accumulate ($inc, $push, ...).
const IDEMPOTENT_UPDATE_OPERATORS = new Set(['$set', '$setOnInsert', '$unset', '$currentDate']);
const INSTALLED = Symbol.for('commonly.upsertRetryInstalled');

type MongoLikeError = { code?: unknown; message?: unknown; writeErrors?: unknown[] };
type AnyFn = (...args: unknown[]) => Promise<unknown>;
type SessionLike = { inTransaction?: () => boolean } | null | undefined;
type ConnectionLike = {
  db?: { admin: () => { command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>> } };
  readyState?: number;
  on?: (event: string, fn: () => void) => void;
};

// --- the gate ---------------------------------------------------------------

let explicit: boolean | null = null;
let detected = false;
let detection: Promise<boolean> | null = null;

const envSetting = (): boolean | null => {
  const raw = String(process.env.MONGO_UPSERT_RETRY ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
};

const isUpsertRetryEnabled = (): boolean => envSetting() ?? explicit ?? detected;
const enableUpsertRetry = (): void => { explicit = true; };
const disableUpsertRetry = (): void => { explicit = false; };
// Hand the decision back to env/detection (tests restore with this).
const resetUpsertRetry = (): void => { explicit = null; };

/** Is the server behind this connection FerretDB? buildInfo says so. */
const detectFerretDb = async (connection: ConnectionLike): Promise<boolean> => {
  const info = await connection.db?.admin().command({ buildInfo: 1 });
  return Boolean(info && info.ferretdb);
};

// Re-detects on every open: a process that reconnects to a different server
// gets that server's answer. A failed probe leaves the retry off (MongoDB's path).
const configureUpsertRetry = (connection: ConnectionLike): Promise<boolean> => {
  const pending = detectFerretDb(connection)
    .then((isFerret) => { detected = isFerret; return isFerret; })
    .catch(() => { detected = false; return false; })
    .finally(() => { if (detection === pending) detection = null; });
  detection = pending;
  return pending;
};

// --- the retry --------------------------------------------------------------

// FerretDB reports a Postgres deadlock between racing upserts as 16908292 from
// updateOne, but as code 1 (InternalError) "deadlock detected" from
// findOneAndUpdate (measured on 2.7). Code 1 counts only with that wording.
const isDeadlockError = (err: unknown): boolean => {
  const { code, message } = (err || {}) as MongoLikeError;
  if (code === FERRETDB_DEADLOCK_CODE) return true;
  return code === 1 && typeof message === 'string' && /deadlock detected/i.test(message);
};

// A lost unique-key race (11000, or FerretDB's code-1 constraint wording; see
// utils/duplicateKeyError) or a FerretDB deadlock between the racers.
const isTransient = (err: unknown): boolean => isDuplicateKeyError(err) || isDeadlockError(err);

// A bulk error's top-level code is only its first write error's; every write
// error has to be a lost race, so read those first when there are any.
const isRetryableError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const { writeErrors } = err as MongoLikeError;
  if (Array.isArray(writeErrors) && writeErrors.length > 0) return writeErrors.every(isTransient);
  return isTransient(err);
};

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Jittered so racing callers spread out instead of colliding again: 5-20ms,
// 10-40ms, 20-80ms, 40-160ms. The sleeps total at most 300ms; on FerretDB the
// bigger cost is Postgres detecting the deadlock itself (deadlock_timeout).
const backoffMs = (attempt: number): number => {
  const base = 5 * (2 ** (attempt - 1));
  return base + Math.floor(Math.random() * base * 3);
};

const withUpsertRetry = async <T>(run: (attempt: number) => Promise<T>): Promise<T> => {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await run(attempt);
    } catch (err) {
      if (attempt >= MAX_UPSERT_ATTEMPTS || !isRetryableError(err)) throw err;
      if (Date.now() - startedAt >= UPSERT_RETRY_BUDGET_MS) throw err;
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoffMs(attempt));
    }
  }
};

const inTransaction = (session: SessionLike): boolean => Boolean(session?.inTransaction?.());

// A query issued while the connection's FerretDB probe is in flight waits for
// the answer rather than guessing; otherwise this is one flag read.
const retryWanted = async (): Promise<boolean> => {
  if (envSetting() === null && explicit === null && detection) await detection;
  return isUpsertRetryEnabled();
};

type QueryLike = {
  op?: string;
  options?: { upsert?: boolean; session?: SessionLike };
  clone: () => QueryLike;
  _transforms?: unknown[];
};

const isUpsertQuery = (query: QueryLike, opArg: unknown): boolean => {
  const op = typeof opArg === 'string' ? opArg : query.op;
  return Boolean(op && UPSERT_OPS.has(op) && query.options?.upsert === true
    && !inTransaction(query.options?.session));
};

// A Mongoose query runs once ("Query was already executed"), and its pre hooks
// cast and mutate the update in place, so each retry runs a fresh clone of the
// query as it stood before the first attempt. clone() drops transforms
// (orFail, lean transforms); carry them over.
const snapshot = (query: QueryLike): QueryLike => {
  const copy = query.clone();
  copy._transforms = Array.isArray(query._transforms) ? query._transforms.slice() : [];
  return copy;
};

const pathsOverlap = (a: string, b: string): boolean => (
  a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
);

const isIdOnlyFilter = (filter: unknown): boolean => (
  Boolean(filter) && typeof filter === 'object' && Object.keys(filter as object).join() === '_id'
);

// A replayed op must land on the same document. If the first run changed a
// field the filter matches on, the replay misses it and inserts a second one.
// So the filter is _id-only, or plain fields none of which the update writes.
const filterSurvivesReplay = (filter: unknown, update: Record<string, unknown>): boolean => {
  if (isIdOnlyFilter(filter)) return true;
  if (!filter || typeof filter !== 'object') return false;
  const filterKeys = Object.keys(filter as object);
  if (filterKeys.some((key) => key.startsWith('$'))) return false;
  const written = ['$set', '$unset', '$currentDate']
    .flatMap((operator) => Object.keys((update[operator] as object) || {}));
  return !filterKeys.some((key) => written.some((path) => pathsOverlap(key, path)));
};

const isIdempotentUpsertOp = (op: unknown): boolean => {
  if (!op || typeof op !== 'object') return false;
  const entries = Object.entries(op as Record<string, { upsert?: boolean; update?: unknown; filter?: unknown }>);
  if (entries.length !== 1) return false;
  const [kind, body] = entries[0];
  if (!body || body.upsert !== true) return false;
  // A replacement rewrites every field, the filter's included.
  if (kind === 'replaceOne') return isIdOnlyFilter(body.filter);
  if (kind !== 'updateOne') return false;
  const { update } = body;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
  const keys = Object.keys(update);
  return keys.length > 0 && keys.every((key) => IDEMPOTENT_UPDATE_OPERATORS.has(key))
    && filterSurvivesReplay(body.filter, update as Record<string, unknown>);
};

const isRetryableBulkWrite = (ops: unknown, options: unknown): boolean => (
  Array.isArray(ops) && ops.length > 0 && ops.every(isIdempotentUpsertOp)
  && !inTransaction((options as { session?: SessionLike } | undefined)?.session)
);

// Model.bulkWrite casts its ops in place; re-casting a cast op is a no-op, so
// a retry passes the ops it was given. Shallow-copying each op keeps a retry
// from seeing a half-cast entry if casting itself threw part way.
const copyOps = (ops: unknown[]): unknown[] => ops.map((op) => {
  const [[kind, body]] = Object.entries(op as Record<string, Record<string, unknown>>);
  return { [kind]: { ...body } };
});

const installUpsertRetry = (mongoose: typeof defaultMongoose = defaultMongoose): void => {
  // A mocked mongoose (jest.mock('mongoose')) has neither; nothing to wrap.
  const QueryProto = mongoose?.Query?.prototype;
  const { Model } = mongoose || {};
  if (!QueryProto || typeof QueryProto.exec !== 'function' || !Model) return;
  if (QueryProto[INSTALLED]) return;

  const originalExec: AnyFn = QueryProto.exec;
  QueryProto.exec = function execWithUpsertRetry(this: QueryLike, ...args: unknown[]) {
    if (!isUpsertQuery(this, args[0])) return originalExec.apply(this, args);
    if (!detection && !isUpsertRetryEnabled()) return originalExec.apply(this, args);
    const pristine = snapshot(this);
    return retryWanted().then((wanted) => (wanted
      ? withUpsertRetry((attempt) => originalExec.apply(attempt === 1 ? this : snapshot(pristine), args))
      : originalExec.apply(this, args)));
  };

  const originalBulkWrite: AnyFn = Model.bulkWrite;
  Model.bulkWrite = function bulkWriteWithUpsertRetry(this: unknown, ops: unknown, ...rest: unknown[]) {
    if (!isRetryableBulkWrite(ops, rest[0])) return originalBulkWrite.call(this, ops, ...rest);
    if (!detection && !isUpsertRetryEnabled()) return originalBulkWrite.call(this, ops, ...rest);
    const pristine = copyOps(ops as unknown[]);
    return retryWanted().then((wanted) => (wanted
      ? withUpsertRetry((attempt) => (
        originalBulkWrite.call(this, attempt === 1 ? ops : copyOps(pristine), ...rest)))
      : originalBulkWrite.call(this, ops, ...rest)));
  };

  // Detect on every open of the default connection, and now if already open.
  const { connection } = mongoose as { connection?: ConnectionLike };
  if (connection && typeof connection.on === 'function') {
    connection.on('connected', () => { configureUpsertRetry(connection); });
    if (connection.readyState === 1) configureUpsertRetry(connection);
  }

  Object.defineProperty(QueryProto, INSTALLED, { value: true });
};

installUpsertRetry();

module.exports = {
  installUpsertRetry,
  configureUpsertRetry,
  enableUpsertRetry,
  disableUpsertRetry,
  resetUpsertRetry,
  isUpsertRetryEnabled,
  isRetryableError,
  MAX_UPSERT_ATTEMPTS,
  UPSERT_RETRY_BUDGET_MS,
  DUPLICATE_KEY_CODE,
  FERRETDB_DEADLOCK_CODE,
};

export {};
