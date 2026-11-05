/**
 * Retry upserts that lost a race on a unique key, in one place.
 *
 * MongoDB retries a duplicate-key upsert internally: 20 concurrent
 * `updateOne({k}, {$inc:{n:1}}, {upsert:true})` calls end as one document with
 * n=20. FerretDB (the Postgres-backed Mongo layer self-hosted Commonly can run
 * on) surfaces the same race to the client, and the run ends at n=15 with
 * five throws: E11000 or a Postgres deadlock (16908292) from updateOne, and
 * code 1 InternalError "violates exclusion constraint" or "deadlock detected"
 * from findOneAndUpdate (measured on FerretDB 2.7).
 * At boot that took down heartbeat dispatch. Rather than wrap each of the
 * backend's upsert call sites, this wraps `Query.prototype.exec` and
 * `Model.bulkWrite` once, so every upsert gets MongoDB's behaviour on both.
 *
 * Retrying is safe because a failed upsert attempt applied nothing: the
 * insert-or-update is a single document write that either commits or errors,
 * and every one of those errors is raised before it commits. The retry re-reads the filter
 * and lands on the row the winner inserted, exactly as MongoDB's own retry does.
 *
 * Only upserts are retried. An E11000 from a plain update or insert is a real
 * uniqueness violation and must surface on its first throw. An upsert whose
 * conflict is real (its filter can never match the row holding the key) still
 * surfaces, just after the bounded retries (at most ~300ms of sleeps). Its
 * caller should test it with utils/duplicateKeyError, which knows both forms.
 *
 * Registered from config/db (the server's connection) and from the test
 * harness (__tests__/utils/testUtils). One-off scripts that call
 * mongoose.connect() themselves are not covered unless they require this.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const defaultMongoose = require('mongoose');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isDuplicateKeyError, DUPLICATE_KEY_CODE } = require('../utils/duplicateKeyError');

const MAX_UPSERT_ATTEMPTS = 5;
// FerretDB's code for a Postgres deadlock (SQLSTATE 40P01) between two upserts.
const FERRETDB_DEADLOCK_CODE = 16908292;
const UPSERT_OPS = new Set(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']);
// A bulkWrite can fail after earlier ops applied (ordered) or around them
// (unordered), so a retry re-runs ops that already landed. That is only safe
// when re-running is a no-op: operators that set a value, never ones that
// accumulate ($inc, $push, ...).
const IDEMPOTENT_UPDATE_OPERATORS = new Set(['$set', '$setOnInsert', '$unset', '$currentDate']);
const INSTALLED = Symbol.for('commonly.upsertRetryInstalled');

type MongoLikeError = { code?: unknown; message?: unknown; writeErrors?: unknown[] };
type AnyFn = (...args: unknown[]) => Promise<unknown>;

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

const isRetryableError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  if (isTransient(err)) return true;
  const { writeErrors } = err as MongoLikeError;
  return Array.isArray(writeErrors) && writeErrors.length > 0 && writeErrors.every(isTransient);
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
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await run(attempt);
    } catch (err) {
      if (attempt >= MAX_UPSERT_ATTEMPTS || !isRetryableError(err)) throw err;
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoffMs(attempt));
    }
  }
};

type QueryLike = {
  op?: string;
  options?: { upsert?: boolean };
  clone: () => QueryLike;
  _transforms?: unknown[];
};

const isUpsertQuery = (query: QueryLike, opArg: unknown): boolean => {
  const op = typeof opArg === 'string' ? opArg : query.op;
  return Boolean(op && UPSERT_OPS.has(op) && query.options?.upsert === true);
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

const isIdempotentUpsertOp = (op: unknown): boolean => {
  if (!op || typeof op !== 'object') return false;
  const entries = Object.entries(op as Record<string, { upsert?: boolean; update?: unknown }>);
  if (entries.length !== 1) return false;
  const [kind, body] = entries[0];
  if (!body || body.upsert !== true) return false;
  if (kind === 'replaceOne') return true;
  if (kind !== 'updateOne' && kind !== 'updateMany') return false;
  const { update } = body;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
  const keys = Object.keys(update);
  return keys.length > 0 && keys.every((key) => IDEMPOTENT_UPDATE_OPERATORS.has(key));
};

const isRetryableBulkWrite = (ops: unknown): boolean => (
  Array.isArray(ops) && ops.length > 0 && ops.every(isIdempotentUpsertOp)
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
    const pristine = snapshot(this);
    return withUpsertRetry((attempt) => (
      originalExec.apply(attempt === 1 ? this : snapshot(pristine), args)
    ));
  };

  const originalBulkWrite: AnyFn = Model.bulkWrite;
  Model.bulkWrite = function bulkWriteWithUpsertRetry(this: unknown, ops: unknown, ...rest: unknown[]) {
    if (!isRetryableBulkWrite(ops)) return originalBulkWrite.call(this, ops, ...rest);
    const pristine = copyOps(ops as unknown[]);
    return withUpsertRetry((attempt) => (
      originalBulkWrite.call(this, attempt === 1 ? ops : copyOps(pristine), ...rest)
    ));
  };

  Object.defineProperty(QueryProto, INSTALLED, { value: true });
};

installUpsertRetry();

module.exports = {
  installUpsertRetry,
  isRetryableError,
  MAX_UPSERT_ATTEMPTS,
  DUPLICATE_KEY_CODE,
  FERRETDB_DEADLOCK_CODE,
};

export {};
