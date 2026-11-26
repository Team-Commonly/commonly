/**
 * F636: the pool stats log against a real mongod and the real driver
 * (mongoose 7.8 / mongodb 5.9). A unit test with a fake emitter can't prove
 * the event names the driver actually emits reach the MongoClient; this does.
 *
 * A separate connection with maxPoolSize 2 runs 20 concurrent finds that each
 * spend ~20 ms server-side, so most checkouts must wait for a connection.
 */
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const { startMongoPoolStats } = require('../../services/mongoPoolStats');

jest.setTimeout(60000);

const field = (line, name) => {
  const m = line.match(new RegExp(`(?:^| )${name}=(\\d+)`));
  return m ? Number(m[1]) : undefined;
};

describe('mongoPoolStats against a real mongod', () => {
  let conn;

  beforeAll(async () => {
    await setupMongoDb();
    // eslint-disable-next-line no-underscore-dangle
    const uri = mongoose.connection._connectionString;
    conn = await mongoose.createConnection(uri, { maxPoolSize: 2 }).asPromise();
    await conn.db.collection('poolstats').insertOne({ n: 1 });
  });

  afterAll(async () => {
    if (conn) await conn.close();
    await closeMongoDb();
  });

  it('sees checkouts wait on a 2-connection pool', async () => {
    const lines = [];
    const stats = startMongoPoolStats(conn.getClient(), {
      intervalMs: 60000,
      log: (line) => lines.push(line),
    });
    try {
      const slow = 'function () { var s = Date.now(); while (Date.now() - s < 20) {} return true; }';
      await Promise.all(Array.from({ length: 20 }, () => conn.db
        .collection('poolstats').find({ $where: slow }).toArray()));
      stats.flush();
    } finally {
      stats.stop();
    }
    expect(lines).toHaveLength(1);
    const line = lines[0];
    process.stdout.write(`${line}\n`);
    expect(field(line, 'checkouts')).toBeGreaterThanOrEqual(20);
    expect(field(line, 'maxCheckedOut')).toBeLessThanOrEqual(2);
    expect(field(line, 'maxCheckedOut')).toBeGreaterThan(0);
    expect(field(line, 'waited')).toBeGreaterThan(0);
    expect(field(line, 'p95')).toBeGreaterThan(0);
    expect(field(line, 'maxWaiting')).toBeGreaterThan(0);
    // every checkout here started after stats did, so each one is sampled
    expect(field(line, 'samples')).toBe(field(line, 'checkouts'));
    expect(field(line, 'waitingNow')).toBe(0);
    expect(field(line, 'failed')).toBe(0);
  });
});
