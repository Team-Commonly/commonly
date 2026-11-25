/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for NeedsYouEmailQuota on real PostgreSQL: migration 0020, and
 * racing dual claims through the real pgTableAdapter SQL that stop at the
 * limit, with verify finding both stores equal.
 */
const fs = require('fs');
const path = require('path');
const { Types } = require('mongoose');

const mockDb = { pool: null };
jest.mock('../../config/db-pg', () => ({
  pool: { query: (...args) => mockDb.pool.query(...args) },
}));

const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const NeedsYouEmailQuota = require('../../models/NeedsYouEmailQuota');
const { claimEmailSlot, emailQuotaStore } = require('../../repositories/needsYouEmailQuotaRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0020_needs_you_email_quotas.sql'), 'utf8',
);
const ENV = 'STORE_MODE_NEEDS_YOU_EMAIL_QUOTA';
const LIMIT = 3;
const DAY = '2026-11-25';

real('NeedsYouEmailQuota on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await NeedsYouEmailQuota.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await NeedsYouEmailQuota.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0020 is a no-op on a second run, count defaults to 0, and (recipient_user_id, day) is unique', async () => {
    await database.pool.query(MIGRATION);
    const insert = (id) => database.pool.query(
      'INSERT INTO needs_you_email_quotas (id, recipient_user_id, day, pg_version) VALUES ($1, $2, $3, 1)',
      [id, 'r1', DAY],
    );
    await insert('a');
    const { rows } = await database.pool.query('SELECT count FROM needs_you_email_quotas');
    expect(rows).toEqual([{ count: 0 }]);
    await expect(insert('b')).rejects.toMatchObject({ code: '23505' });
  });

  it('dual: racing claims take exactly the limit in both stores, and verify finds them equal', async () => {
    process.env[ENV] = 'dual';
    const recipient = new Types.ObjectId();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => claimEmailSlot(recipient, DAY, LIMIT)));
    expect(outcomes.filter(Boolean)).toHaveLength(LIMIT);
    expect(await claimEmailSlot(recipient, DAY, LIMIT)).toBe(false);

    const doc = await NeedsYouEmailQuota.findOne({ recipientUserId: recipient, day: DAY }).lean();
    expect(doc).toMatchObject({ count: LIMIT, pgVersion: LIMIT + 1 });
    const { rows } = await database.pool.query('SELECT * FROM needs_you_email_quotas');
    expect(rows).toEqual([{
      id: String(doc._id), recipient_user_id: String(recipient), day: DAY, count: LIMIT, pg_version: LIMIT + 1,
    }]);
    const verified = await emailQuotaStore().verify();
    expect(verified).toMatchObject({
      mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
    });
    expect(verified.checksumPg).toBe(verified.checksumMongo);
  });
});
