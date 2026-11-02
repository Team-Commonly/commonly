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
let verifyCopied;
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
  const DAY = 24 * 60 * 60 * 1000;
  const retentionBefore = process.env.PG_MESSAGE_RETENTION_DAYS;
  beforeAll(async () => {
    // The fixed dates below predate any 30-day window; retention has its own tests.
    process.env.PG_MESSAGE_RETENTION_DAYS = '36500';
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
    ({ backfillLocalMessages, productionDeps, verifyCopied } = require('../../scripts/backfill-local-messages-to-pg'));
    // eslint-disable-next-line global-require
    ({ ensureLegacyIdIndex } = require('../../services/legacyMessageCopy'));
    expect(await ensureLegacyIdIndex()).toBeTruthy();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM messages WHERE content LIKE $1', [`${MARKER}%`]);
    await clearMongoDb();
  });

  afterAll(async () => {
    if (retentionBefore === undefined) delete process.env.PG_MESSAGE_RETENTION_DAYS;
    else process.env.PG_MESSAGE_RETENTION_DAYS = retentionBefore;
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

  test('a pod that exists only in MongoDB is mirrored into PG, then its message copies', async () => {
    const mongoOnlyPod = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('pods').insertOne({
      _id: mongoOnlyPod,
      name: 'mongo-only-backfill-503',
      type: 'chat',
      createdBy: new mongoose.Types.ObjectId(USER),
      members: [new mongoose.Types.ObjectId(USER)],
    });
    const doc = await MongoMessage.create({
      podId: mongoOnlyPod, userId: USER, content: `${MARKER} mongo-only pod`, messageType: 'text',
    });
    try {
      // A live Mongo pod is not an orphan, before the mirror and after it.
      const dry = await backfillLocalMessages(productionDeps(pool), { force: true });
      expect(dry).toMatchObject({ dryRun: true, pending: 1, orphanedPending: 0 });
      const report = await backfillLocalMessages(productionDeps(pool), { apply: true, force: true });
      expect(report).toMatchObject({ pending: 1, moved: 1, failed: 0, orphanedPending: 0, orphaned: 0 });
      expect(await pgCopies()).toEqual([doc._id.toString()]);
      const { rows } = await pool.query('SELECT id FROM pods WHERE id = $1', [mongoOnlyPod.toHexString()]);
      expect(rows).toHaveLength(1);
    } finally {
      await pool.query('DELETE FROM messages WHERE pod_id = $1', [mongoOnlyPod.toHexString()]);
      await pool.query('DELETE FROM pods WHERE id = $1', [mongoOnlyPod.toHexString()]);
    }
  });

  test('a message whose pod is gone from both stores is skipped as orphaned and never fails the run', async () => {
    const deletedPod = new mongoose.Types.ObjectId();
    const orphan = await MongoMessage.create({
      podId: deletedPod, userId: USER, content: `${MARKER} deleted pod`, messageType: 'text',
    });
    const live = await mongoMessage('live pod');
    const deps = productionDeps(pool);

    const dry = await backfillLocalMessages(deps, { force: true });
    expect(dry).toMatchObject({ dryRun: true, pending: 2, orphanedPending: 1, orphaned: 0 });

    const applied = await backfillLocalMessages(deps, { apply: true, force: true });
    expect(applied).toMatchObject({ pending: 2, orphanedPending: 1, moved: 1, orphaned: 1, failed: 0 });
    expect(await pgCopies()).toEqual([live._id.toString()]);
    const { rows } = await pool.query('SELECT id FROM pods WHERE id = $1', [deletedPod.toHexString()]);
    expect(rows).toHaveLength(0);
    const left = await MongoMessage.findById(orphan._id).lean();
    expect(left.reconciledAt).toBeUndefined();
  });

  test('since copies only Mongo rows created at or after it', async () => {
    const since = new Date('2026-09-30T00:00:00Z');
    await mongoMessage('older history', new Date('2026-09-29T23:59:59Z'));
    const atSince = await mongoMessage('at since', since);
    const after = await mongoMessage('recent tail', new Date('2026-10-20T00:00:00Z'));
    const deps = productionDeps(pool, { since });

    const dry = await backfillLocalMessages(deps, { force: true });
    expect(dry).toMatchObject({ dryRun: true, pending: 2, moved: 0 });

    const applied = await backfillLocalMessages(deps, { apply: true, force: true });
    expect(applied).toMatchObject({ pending: 2, moved: 2, failed: 0 });
    expect(await pgCopies()).toEqual([atSince._id.toString(), after._id.toString()].sort());
  });

  test('a row past retention in a pod Pro does not protect stays in Mongo; a protected pod\'s row copies', async () => {
    // eslint-disable-next-line global-require
    const retention = require('../../services/pgRetentionService');
    const protectedPod = new mongoose.Types.ObjectId().toHexString();
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, 'chat', $3) ON CONFLICT (id) DO NOTHING",
      [protectedPod, 'local-backfill-503-pro', USER],
    );
    const spy = jest.spyOn(retention, 'resolveProtectedPodIds').mockResolvedValue([protectedPod]);
    process.env.PG_MESSAGE_RETENTION_DAYS = '30';
    try {
      const old = new Date(Date.now() - 40 * DAY);
      const expired = await mongoMessage('past retention', old);
      const kept = await MongoMessage.create({
        podId: protectedPod, userId: USER, content: `${MARKER} pro history`, messageType: 'text', createdAt: old,
      });
      const recent = await mongoMessage('recent');

      const dry = await backfillLocalMessages(productionDeps(pool), { force: true });
      expect(dry).toMatchObject({
        pending: 3, expiredPending: 1, orphanedPending: 0, toCopy: 2,
      });

      const applied = await backfillLocalMessages(productionDeps(pool), { apply: true, force: true });
      expect(applied).toMatchObject({ moved: 2, expired: 1, failed: 0 });
      expect(await pgCopies()).toEqual([kept._id.toString(), recent._id.toString()].sort());
      expect((await MongoMessage.findById(expired._id).lean()).reconciledAt).toBeUndefined();

      const after = await backfillLocalMessages(productionDeps(pool), { force: true });
      expect(after).toMatchObject({ pending: 1, expiredPending: 1, toCopy: 0 });
    } finally {
      process.env.PG_MESSAGE_RETENTION_DAYS = '36500';
      spy.mockRestore();
      await pool.query('DELETE FROM messages WHERE pod_id = $1', [protectedPod]);
      await pool.query('DELETE FROM pods WHERE id = $1', [protectedPod]);
    }
  });

  test('a row past retention in a pod PG_RETENTION_EXEMPT_POD_IDS lists copies, as the delete keeps it', async () => {
    const exempt = new mongoose.Types.ObjectId().toHexString();
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, 'chat', $3) ON CONFLICT (id) DO NOTHING",
      [exempt, 'local-backfill-503-exempt', USER],
    );
    const envBefore = process.env.PG_RETENTION_EXEMPT_POD_IDS;
    process.env.PG_RETENTION_EXEMPT_POD_IDS = `other, ${exempt}`;
    process.env.PG_MESSAGE_RETENTION_DAYS = '30';
    try {
      const kept = await MongoMessage.create({
        podId: exempt, userId: USER, content: `${MARKER} exempt history`, messageType: 'text',
        createdAt: new Date(Date.now() - 40 * DAY),
      });
      const dry = await backfillLocalMessages(productionDeps(pool), { force: true });
      expect(dry).toMatchObject({ pending: 1, expiredPending: 0, toCopy: 1 });
      const applied = await backfillLocalMessages(productionDeps(pool), { apply: true, force: true });
      expect(applied).toMatchObject({ moved: 1, expired: 0, failed: 0 });
      expect(await pgCopies()).toEqual([kept._id.toString()]);
    } finally {
      process.env.PG_MESSAGE_RETENTION_DAYS = '36500';
      if (envBefore === undefined) delete process.env.PG_RETENTION_EXEMPT_POD_IDS;
      else process.env.PG_RETENTION_EXEMPT_POD_IDS = envBefore;
      await pool.query('DELETE FROM messages WHERE pod_id = $1', [exempt]);
      await pool.query('DELETE FROM pods WHERE id = $1', [exempt]);
    }
  });

  test('--verify matches copied rows per pod, and names the pod once a copy differs', async () => {
    await mongoMessage('one');
    await MongoMessage.create({
      podId: POD, userId: USER, content: `${MARKER} card`, messageType: 'card', authorKind: 'kernel',
      payload: { state: 'open', kind: 'approval', at: new Date('2026-10-01T12:00:00Z') },
    });
    await backfillLocalMessages(productionDeps(pool), { apply: true, force: true });

    const clean = await verifyCopied(productionDeps(pool));
    // Other suites may leave copied rows in the shared database, so only this pod is asserted.
    expect(clean.differing).not.toContain(POD);

    await pool.query(
      "UPDATE messages SET payload = jsonb_set(payload, '{state}', '\"done\"') WHERE pod_id = $1 AND payload IS NOT NULL",
      [POD],
    );
    expect((await verifyCopied(productionDeps(pool))).differing).toContain(POD);
    await pool.query(
      "UPDATE messages SET payload = jsonb_set(payload, '{state}', '\"open\"'), author_kind = NULL WHERE pod_id = $1 AND payload IS NOT NULL",
      [POD],
    );
    expect((await verifyCopied(productionDeps(pool))).differing).toContain(POD);
    await pool.query("UPDATE messages SET author_kind = 'kernel' WHERE pod_id = $1 AND payload IS NOT NULL", [POD]);
    expect((await verifyCopied(productionDeps(pool))).differing).not.toContain(POD);

    await pool.query(
      'UPDATE messages SET content = content || $2 WHERE pod_id = $1 AND legacy_mongo_id IS NOT NULL',
      [POD, ' (edited)'],
    );
    const edited = await verifyCopied(productionDeps(pool));
    expect(edited.differing).toContain(POD);
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
