/**
 * Stands in for `mongodb-memory-server` when JEST_EXTERNAL_MONGO_URI is set (the
 * FerretDB CI leg, .github/workflows/backend-ferretdb.yml). jest.config.js maps
 * the package here only then, so a suite that starts its own server with
 * `MongoMemoryServer.create()` runs against the store under test instead of an
 * in-memory mongod that would answer the same on both legs.
 *
 * Each create() gets its own database on that server, dropped by stop().
 * `new MongoMemoryServer(...)` is left as the real class: the one suite that
 * constructs one directly tests mongodb-memory-server itself, not a store.
 */
/* eslint-disable max-classes-per-file -- the stand-in and the class suites import */
const crypto = require('crypto');
// The package mongodb-memory-server re-exports; requiring it by its own name
// here would map back to this file.
// eslint-disable-next-line import/no-extraneous-dependencies
const real = require('mongodb-memory-server-core');

// The driver's own parser: a seed list (`host1,host2/?replicaSet=rs0`) is not
// a WHATWG URL. A URI with credentials and no authSource authenticates against
// `admin`; naming a test database in the path would move that, so it is pinned.
// eslint-disable-next-line import/no-extraneous-dependencies
const ConnectionString = require('mongodb-connection-string-url').default;

const withDatabase = (base, db) => {
  const url = new ConnectionString(base);
  if (url.username && !url.searchParams.has('authSource')) {
    url.searchParams.set('authSource', url.pathname.replace(/^\//, '') || 'admin');
  }
  url.pathname = `/${db}`;
  return url.toString();
};

class ExternalMongoServer {
  constructor() {
    this.db = `m${crypto.randomBytes(6).toString('hex')}`;
    this.uri = withDatabase(process.env.JEST_EXTERNAL_MONGO_URI, this.db);
  }

  getUri(dbName) {
    // The real getUri(true) generates a fresh database name.
    if (dbName === true) return withDatabase(process.env.JEST_EXTERNAL_MONGO_URI, `m${crypto.randomBytes(6).toString('hex')}`);
    return dbName ? withDatabase(process.env.JEST_EXTERNAL_MONGO_URI, dbName) : this.uri;
  }

  async start() {
    return this;
  }

  async stop() {
    // eslint-disable-next-line global-require -- loaded only on the external path
    const { MongoClient } = require('mongoose').mongo;
    const client = await MongoClient.connect(this.uri);
    try {
      await client.db(this.db).dropDatabase();
    } catch (error) {
      // a suite that never wrote leaves no database to drop
    } finally {
      await client.close();
    }
    return true;
  }
}

class MongoMemoryServer extends real.MongoMemoryServer {
  static async create() {
    return new ExternalMongoServer();
  }
}

module.exports = { ...real, MongoMemoryServer, withDatabase };
