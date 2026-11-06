/**
 * The FerretDB CI leg names a fresh database per suite inside whatever URI it
 * is given (__tests__/utils/externalMongoMemoryServer.js).
 */
const { withDatabase } = require('../../utils/externalMongoMemoryServer');

describe('withDatabase', () => {
  it('sets the database on a single-host URI', () => {
    expect(withDatabase('mongodb://localhost:27018', 'tabc')).toBe('mongodb://localhost:27018/tabc');
    expect(withDatabase('mongodb://localhost:27018/', 'tabc')).toBe('mongodb://localhost:27018/tabc');
  });

  it('keeps a seed list and its options', () => {
    expect(withDatabase('mongodb://h1:27017,h2:27017/?replicaSet=rs0', 'tabc'))
      .toBe('mongodb://h1:27017,h2:27017/tabc?replicaSet=rs0');
  });

  it('keeps credentials authenticating where they did: admin, or the database the URI named', () => {
    expect(withDatabase('mongodb://u:p@localhost:27017', 'tabc'))
      .toBe('mongodb://u:p@localhost:27017/tabc?authSource=admin');
    expect(withDatabase('mongodb://u:p@localhost:27017/ci', 'tabc'))
      .toBe('mongodb://u:p@localhost:27017/tabc?authSource=ci');
    expect(withDatabase('mongodb://u:p@localhost:27017/?authSource=ops', 'tabc'))
      .toBe('mongodb://u:p@localhost:27017/tabc?authSource=ops');
  });
});
