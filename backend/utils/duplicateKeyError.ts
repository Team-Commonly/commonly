/**
 * Did this write lose to a unique index?
 *
 * MongoDB always says so with code 11000. FerretDB 2.7 (the Postgres-backed
 * Mongo layer self-hosted Commonly can run on) says so with 11000 for
 * updateOne and insertOne, but a findOneAndUpdate that hits a unique index
 * comes back as code 1 (InternalError) carrying Postgres's own wording:
 * "violates exclusion constraint" (or "unique constraint"). Code that treats a
 * lost race as "someone else won" must recognise both forms, or on FerretDB
 * the loser of an ordinary race becomes a 500.
 *
 * Code 1 is only matched with that wording: a bare InternalError is anything.
 */
const DUPLICATE_KEY_CODE = 11000;
const INTERNAL_ERROR_CODE = 1;
const POSTGRES_UNIQUE_WORDING = /violates (exclusion|unique) constraint|duplicate key/i;

export const isDuplicateKeyError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === DUPLICATE_KEY_CODE) return true;
  return code === INTERNAL_ERROR_CODE
    && typeof message === 'string'
    && POSTGRES_UNIQUE_WORDING.test(message);
};

export { DUPLICATE_KEY_CODE };
