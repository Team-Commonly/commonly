/**
 * TASK-313 part 2 — Mongo fallback messages reconciled into PostgreSQL.
 *
 * Runs against real PostgreSQL and real MongoDB (Tier 1). The claims need a
 * database that enforces them: ON CONFLICT on a unique index, a foreign key
 * from messages.pod_id to pods(id), and two concurrent passes racing on the
 * same rows. pg-mem can do none of that faithfully.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Pool } = require('pg');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const RUN = process.env.INTEGRATION_TEST === 'true';
const d = RUN ? describe : describe.skip;
const MARKER = 'tier1-reconcile-313';

let pool;
let MongoMessage;
let reconcile;
let PGMessage;
let MessageReaction;

const POD = new mongoose.Types.ObjectId().toHexString();
const USER = new mongoose.Types.ObjectId().toHexString();

const connect = () => new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

const insertFallback = (content, extra = {}) => MongoMessage.create({
  podId: POD,
  userId: USER,
  content: `${MARKER} ${content}`,
  messageType: 'text',
  createdAt: new Date(),
  ...extra,
});

const pgRowsFor = async (mongoId) => (await pool.query(
  'SELECT id, content, created_at FROM messages WHERE legacy_mongo_id = $1',
  [String(mongoId)],
)).rows;

d('TASK-313 part 2: reconcile Mongo fallback messages into PostgreSQL', () => {
  beforeAll(async () => {
    pool = connect();
    await pool.query(fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8'));
    await pool.query(
      `INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, 'chat', $3)
       ON CONFLICT (id) DO NOTHING`,
      [POD, 'reconcile-313', USER],
    );
    await setupMongoDb();
    // The app's own pool and models: this is the code under test.
    // eslint-disable-next-line global-require
    MongoMessage = require('../../models/Message');
    // eslint-disable-next-line global-require
    ({ reconcileMongoFallbackMessages: reconcile } = require('../../services/pgMessageReconcileService'));
    // eslint-disable-next-line global-require
    PGMessage = require('../../models/pg/Message');
    // eslint-disable-next-line global-require
    MessageReaction = require('../../models/pg/MessageReaction').default;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM messages WHERE content LIKE $1', [`${MARKER}%`]);
    await clearMongoDb();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM messages WHERE content LIKE $1', [`${MARKER}%`]);
    await pool.query('DELETE FROM pods WHERE id = $1', [POD]);
    await pool.end();
    await closeMongoDb();
    // The app's pool is module-scoped; close it so Jest does not hold the process.
    // eslint-disable-next-line global-require
    const { pool: appPool } = require('../../config/db-pg');
    if (appPool?.end) await appPool.end();
  });

  test('moves a fallback message once and keeps its Mongo id as the legacy id', async () => {
    const doc = await insertFallback('a');

    const pass = await reconcile();

    expect(pass.moved).toBe(1);
    const rows = await pgRowsFor(doc._id);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(`${MARKER} a`);
    expect(new Date(rows[0].created_at).getTime()).toBe(doc.createdAt.getTime());
    const after = await MongoMessage.findById(doc._id).lean();
    expect(after.reconciledAt).toBeInstanceOf(Date);
    expect(after.reconciledPgId).toBe(Number(rows[0].id));
  });

  test('each message appears once in the Postgres read after a reconcile, and a second pass moves nothing', async () => {
    await insertFallback('b1');
    await insertFallback('b2');

    await reconcile();
    const second = await reconcile();

    expect(second.moved).toBe(0);
    const listed = await PGMessage.findByPodId(POD, 50);
    const ours = listed.filter((m) => String(m.content).startsWith(`${MARKER} b`));
    expect(ours).toHaveLength(2);
    expect(new Set(ours.map((m) => m._id)).size).toBe(2);
  });

  test('two concurrent passes leave exactly one Postgres row per message', async () => {
    const doc = await insertFallback('c');

    const [x, y] = await Promise.all([reconcile(), reconcile()]);

    expect(x.moved + y.moved).toBe(1);
    expect(await pgRowsFor(doc._id)).toHaveLength(1);
    const stamped = await MongoMessage.findById(doc._id).lean();
    expect(stamped.reconciledAt).toBeInstanceOf(Date);
  });

  test('a pass is bounded by maxPerPass and the remainder moves on the next pass', async () => {
    await insertFallback('d1');
    await insertFallback('d2');
    await insertFallback('d3');

    const first = await reconcile({ maxPerPass: 2 });
    const second = await reconcile({ maxPerPass: 2 });

    expect(first.moved).toBe(2);
    expect(second.moved).toBe(1);
  });

  test('a row whose pod is not in Postgres is refused once and does not block the pass behind it', async () => {
    const orphan = await insertFallback('e-orphan', { podId: new mongoose.Types.ObjectId().toHexString() });
    const doc = await insertFallback('e-ok');

    const pass = await reconcile({ maxPerPass: 1 });
    const next = await reconcile({ maxPerPass: 1 });

    expect(pass.skipped).toBe(1);
    const refused = await MongoMessage.findById(orphan._id).lean();
    expect(refused.reconcileFailedAt).toBeInstanceOf(Date);
    expect(await pgRowsFor(doc._id)).toHaveLength(1);
    expect(next.moved).toBe(1);
  });

  test('a moved message resolves its Mongo id for delete', async () => {
    const doc = await insertFallback('f');
    await reconcile();
    const pgId = await PGMessage.resolveId(String(doc._id));
    expect(pgId).toBe(String((await pgRowsFor(doc._id))[0].id));

    await PGMessage.delete(String(doc._id));

    expect(await pgRowsFor(doc._id)).toHaveLength(0);
  });

  test('a moved message resolves its Mongo id for reactions', async () => {
    const doc = await insertFallback('g');
    await reconcile();
    const pgId = await PGMessage.resolveId(String(doc._id));

    await MessageReaction.add(pgId, USER, '👍');

    const summaries = await MessageReaction.listForMessage(pgId, USER);
    expect(summaries.map((s) => s.emoji)).toEqual(['👍']);
  });
});
