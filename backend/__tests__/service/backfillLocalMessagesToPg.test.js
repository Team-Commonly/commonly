/**
 * TASK-503 — the local-upgrade backfill against real PostgreSQL and MongoDB.
 *
 * The unit suite fakes every dependency, so it cannot see the overlap SQL or
 * copyOne's ON CONFLICT. Here both run for real. Overlap is asserted as a
 * delta, since other suites may leave unmarked rows in a shared database.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Pool } = require('pg');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const RUN = process.env.INTEGRATION_TEST === 'true';
const d = RUN ? describe : describe.skip;
const MARKER = 'tier1-local-backfill-503';

let pool;
let MongoMessage;
let backfillLocalMessages;
let productionDeps;
let ensureLegacyIdIndex;

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

const mongoMessage = (content, createdAt = new Date()) => MongoMessage.create({
  podId: POD, userId: USER, content: `${MARKER} ${content}`, messageType: 'text', createdAt,
});

const pgUnmarked = (content, createdAt) => pool.query(
  'INSERT INTO messages (pod_id, user_id, content, created_at) VALUES ($1, $2, $3, $4)',
  [POD, USER, `${MARKER} ${content}`, createdAt],
);

const pgCopies = async () => (await pool.query(
  'SELECT legacy_mongo_id FROM messages WHERE content LIKE $1 AND legacy_mongo_id IS NOT NULL',
  [`${MARKER}%`],
)).rows.map((r) => r.legacy_mongo_id).sort();

d('TASK-503: local-upgrade backfill into PostgreSQL', () => {
  beforeAll(async () => {
    pool = connect();
    await pool.query(fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8'));
    // Added by migration 0001, which schema.sql alone does not carry.
    await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS legacy_mongo_id TEXT');
    await pool.query(
      `INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, 'chat', $3)
       ON CONFLICT (id) DO NOTHING`,
      [POD, 'local-backfill-503', USER],
    );
    await setupMongoDb();
    // eslint-disable-next-line global-require
    MongoMessage = require('../../models/Message');
    // eslint-disable-next-line global-require
    ({ backfillLocalMessages, productionDeps } = require('../../scripts/backfill-local-messages-to-pg'));
    // eslint-disable-next-line global-require
    ({ ensureLegacyIdIndex } = require('../../services/pgMessageReconcileService'));
    expect(await ensureLegacyIdIndex()).toBeTruthy();
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
    // eslint-disable-next-line global-require
    const { pool: appPool } = require('../../config/db-pg');
    if (appPool?.end) await appPool.end();
  });

  test('overlap counts only unmarked PG rows written at or before the given time', async () => {
    const deps = productionDeps(pool);
    const at = new Date('2026-01-10T00:00:00Z');
    const before = await deps.countOverlap(at);
    await pgUnmarked('older', new Date('2026-01-01T00:00:00Z'));
    await pgUnmarked('same instant', at);
    await pgUnmarked('newer', new Date('2026-02-01T00:00:00Z'));
    await pool.query(
      `INSERT INTO messages (pod_id, user_id, content, created_at, legacy_mongo_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [POD, USER, `${MARKER} marked`, new Date('2026-01-01T00:00:00Z'), new mongoose.Types.ObjectId().toHexString()],
    );
    expect(await deps.countOverlap(at)).toBe(before + 2);
  });

  test('a dry run writes nothing, --apply copies once, and a rerun copies nothing', async () => {
    const docs = [await mongoMessage('a'), await mongoMessage('b'), await mongoMessage('c')];
    const ids = docs.map((doc) => doc._id.toString()).sort();
    const deps = productionDeps(pool);
    // force: other suites may leave unmarked rows; the refusal has its own test.
    const dry = await backfillLocalMessages(deps, { force: true });
    expect(dry).toMatchObject({ dryRun: true, pending: 3, moved: 0 });
    expect(await pgCopies()).toEqual([]);

    const applied = await backfillLocalMessages(deps, { apply: true, force: true, batchSize: 2 });
    expect(applied).toMatchObject({ pending: 3, moved: 3, failed: 0 });
    expect(await pgCopies()).toEqual(ids);

    const rerun = await backfillLocalMessages(deps, { apply: true, force: true });
    expect(rerun).toMatchObject({ pending: 0, moved: 0 });
    expect(await pgCopies()).toEqual(ids);
  });

  test('refuses when PG holds unmarked history older than the newest Mongo message', async () => {
    await pgUnmarked('copied by an older migration', new Date('2026-01-01T00:00:00Z'));
    await mongoMessage('same history', new Date('2026-01-02T00:00:00Z'));
    const report = await backfillLocalMessages(productionDeps(pool), { apply: true });
    expect(report.refused).toBe(true);
    expect(report.overlap).toBeGreaterThanOrEqual(1);
    expect(report.moved).toBe(0);
    expect(await pgCopies()).toEqual([]);
  });
});
