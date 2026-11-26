/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for DiscordSummaryHistory on real PostgreSQL: migration 0023,
 * and dual inserts through the real pgTableAdapter SQL (time_range as JSONB),
 * with verify finding both stores equal.
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
const DiscordSummaryHistory = require('../../models/DiscordSummaryHistory');
const {
  discordSummaryHistoryStore, recordDiscordSummary,
} = require('../../repositories/discordSummaryHistoryRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0023_discord_summary_histories.sql'),
  'utf8',
);
const ENV = 'STORE_MODE_DISCORD_SUMMARY_HISTORY';
const START = new Date('2026-01-01T10:00:00.000Z');
const END = new Date('2026-01-01T11:00:00.000Z');

real('DiscordSummaryHistory on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await DiscordSummaryHistory.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await DiscordSummaryHistory.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0023 is a no-op on a second run, with the integration and type indexes', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
        AND tablename = 'discord_summary_histories' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'discord_summary_histories_integration_created',
      'discord_summary_histories_pkey',
      'discord_summary_histories_summary_type',
    ]);
  });

  it('dual: each insert lands once in both stores, and verify finds them equal', async () => {
    process.env[ENV] = 'dual';
    const integrationId = new Types.ObjectId();
    await recordDiscordSummary({
      integrationId,
      summaryType: 'hourly',
      content: 'A test summary of a test pod.',
      messageCount: 3,
      timeRange: { start: START, end: END },
      postedToCommonly: false,
      postedToDiscord: false,
    });
    await recordDiscordSummary({
      integrationId,
      summaryType: 'manual',
      content: 'A second test summary.',
      messageCount: 1,
      timeRange: { start: START, end: END },
    });

    const docs = await DiscordSummaryHistory.find({}).sort({ messageCount: -1 }).lean();
    expect(docs.map((d) => d.pgVersion)).toEqual([1, 1]);
    const { rows } = await database.pool.query(
      'SELECT * FROM discord_summary_histories ORDER BY message_count DESC',
    );
    expect(rows).toEqual(docs.map((doc) => ({
      id: String(doc._id),
      integration_id: String(integrationId),
      summary_type: doc.summaryType,
      content: doc.content,
      message_count: doc.messageCount,
      time_range: { start: START.toISOString(), end: END.toISOString() },
      posted_to_discord: false,
      posted_to_commonly: false,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
      pg_version: 1,
    })));
    const verified = await discordSummaryHistoryStore().verify();
    expect(verified).toMatchObject({
      mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
    });
    expect(verified.checksumPg).toBe(verified.checksumMongo);

    // pg-read reads the row back in the lean Mongo shape.
    process.env[ENV] = 'pg-read';
    const { pgVersion, pgPending, __v, ...lean } = docs[0];
    expect(await discordSummaryHistoryStore().findById(docs[0]._id)).toEqual(lean);
  });
});
