// A write that lost to a unique index is "someone else won", not a failure.
// MongoDB says so with 11000; FerretDB's findOneAndUpdate says it with code 1
// and Postgres's constraint wording. Both must read as a duplicate.
const { isDuplicateKeyError } = require('../../../utils/duplicateKeyError');

describe('isDuplicateKeyError', () => {
  it('recognises MongoDB and FerretDB code 11000', () => {
    expect(isDuplicateKeyError({ code: 11000, message: 'E11000 duplicate key error collection: x' })).toBe(true);
    expect(isDuplicateKeyError({ code: 11000, message: 'Duplicate key violation' })).toBe(true);
  });

  it('recognises FerretDB findOneAndUpdate code 1 with Postgres constraint wording', () => {
    expect(isDuplicateKeyError({
      code: 1,
      codeName: 'InternalError',
      message: 'conflicting key value violates exclusion constraint "documents_rum_index_4026"',
    })).toBe(true);
    expect(isDuplicateKeyError({
      code: 1, message: 'duplicate key value violates unique constraint "collection_pk_98"',
    })).toBe(true);
  });

  it('does not treat any other code-1 InternalError as a duplicate', () => {
    expect(isDuplicateKeyError({ code: 1, message: 'connection reset by peer' })).toBe(false);
    expect(isDuplicateKeyError({ code: 1 })).toBe(false);
  });

  it('rejects other codes and non-errors', () => {
    expect(isDuplicateKeyError({ code: 16908292, message: 'deadlock detected' })).toBe(false);
    expect(isDuplicateKeyError({ code: 2, message: 'violates unique constraint' })).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError('E11000')).toBe(false);
  });
});
