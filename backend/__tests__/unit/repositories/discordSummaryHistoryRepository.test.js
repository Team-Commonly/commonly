/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for the Discord summary history. The repository's Postgres
// table is the in-memory adapter here; Mongo is real, so validation, defaults
// and timestamps are the production schema's.
const mockPg = { current: null, options: null };
jest.mock('../../../repositories/dualStore', () => {
  const actual = jest.requireActual('../../../repositories/dualStore');
  const forward = (method) => (...args) => mockPg.current[method](...args);
  return {
    ...actual,
    pgTableAdapter: (options) => {
      mockPg.options = options;
      return Object.fromEntries(['upsert', 'remove', 'replace', 'removeAt', 'get', 'scan', 'findWhere']
        .map((m) => [m, forward(m)]));
    },
  };
});
const fs = require('fs');
const path = require('path');
const { Types } = require('mongoose');
const DiscordSummaryHistory = require('../../../models/DiscordSummaryHistory');
const {
  discordSummaryHistoryStore, recordDiscordSummary,
} = require('../../../repositories/discordSummaryHistoryRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_DISCORD_SUMMARY_HISTORY';
const START = new Date('2026-01-01T10:00:00.000Z');
const END = new Date('2026-01-01T11:00:00.000Z');

// What each service passes: fake content, a fresh fake integration id.
const fields = (over = {}) => ({
  integrationId: new Types.ObjectId(),
  summaryType: 'hourly',
  content: 'A test summary of a test pod.',
  messageCount: 3,
  timeRange: { start: START, end: END },
  postedToCommonly: false,
  postedToDiscord: false,
  ...over,
});

describe('discord summary history repository (ADR-034 step 2)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await DiscordSummaryHistory.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await DiscordSummaryHistory.deleteMany({});
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await discordSummaryHistoryStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const byContent = (content) => DiscordSummaryHistory.findOne({ content }).lean();
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;
  const STORE_FIELDS = ['_id', 'createdAt', 'updatedAt', 'pgVersion', 'pgPending', 'pgDeleted'];
  const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !STORE_FIELDS.includes(key)));
  // The pre-step-2 write, as both services made it.
  const oldWrite = (input) => new DiscordSummaryHistory(input).save();

  it('declares the table, the id and time_range as JSON', () => {
    discordSummaryHistoryStore();
    expect(mockPg.options).toMatchObject({
      table: 'discord_summary_histories', idColumn: 'id', jsonColumns: ['time_range'],
    });
  });

  it('names the columns 0023 creates, and nothing else', () => {
    discordSummaryHistoryStore();
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0023_discord_summary_histories.sql'),
      'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|INTEGER|TIMESTAMPTZ|BOOLEAN|JSONB)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
  });

  describe('mongo (the default)', () => {
    it('stores the same document the old save() stored, with no markers and no Postgres call', async () => {
      const input = fields();
      await oldWrite({ ...input, content: 'old' });
      await expect(recordDiscordSummary({ ...input, content: 'new' })).resolves.toBeUndefined();

      const before = await byContent('old');
      const after = await byContent('new');
      expect({ ...payload(after), content: 'old' }).toEqual(payload(before));
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      expect(after.createdAt).toBeInstanceOf(Date);
      expect(after.updatedAt).toBeInstanceOf(Date);
      expect(after.pgVersion).toBeUndefined();
      expect(after.pgPending).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('applies the schema defaults when the flags are left out', async () => {
      const { postedToCommonly, postedToDiscord, ...rest } = fields();
      await recordDiscordSummary(rest);
      expect(await byContent(rest.content)).toMatchObject({ postedToCommonly: false, postedToDiscord: false });
    });

    it('rejects a missing field as save() does, and writes nothing', async () => {
      const bad = fields({ content: undefined });
      const oldError = await oldWrite(bad).catch((error) => error);
      const newError = await recordDiscordSummary(bad).catch((error) => error);
      expect(newError.name).toBe('ValidationError');
      expect(Object.keys(newError.errors)).toEqual(Object.keys(oldError.errors));
      expect(await DiscordSummaryHistory.countDocuments({})).toBe(0);
      expect(mockPg.current.calls).toEqual([]);
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('stores the same document as mongo, and copies the insert once', async () => {
      const input = fields();
      delete process.env[ENV];
      await recordDiscordSummary({ ...input, content: 'in mongo' });
      process.env[ENV] = mode;

      await recordDiscordSummary({ ...input, content: 'in dual' });
      const mongoDoc = await byContent('in mongo');
      const doc = await byContent('in dual');
      expect({ ...payload(doc), content: 'in mongo' }).toEqual(payload(mongoDoc));
      expect(doc.pgVersion).toBe(1);
      expect(doc.pgPending).toBeUndefined();
      expect(upserts()).toBe(1);
      expect(mockPg.current.rows.get(String(doc._id))).toEqual({
        row: {
          id: String(doc._id),
          integration_id: String(input.integrationId),
          summary_type: 'hourly',
          content: 'in dual',
          message_count: 3,
          time_range: { start: START.toISOString(), end: END.toISOString() },
          posted_to_discord: false,
          posted_to_commonly: false,
          created_at: doc.createdAt,
          updated_at: doc.updatedAt,
        },
        version: 1,
      });
      // The mongo-mode document was never copied.
      expect(await discordSummaryHistoryStore().verify()).toMatchObject({
        mongo: 2, pg: 1, missing: 1, differs: 0, extra: 0,
      });
    });

    it('each insert is its own document and its own copy', async () => {
      const input = fields();
      await Promise.all([1, 2, 3].map((n) => recordDiscordSummary({ ...input, content: `summary ${n}` })));
      expect(await DiscordSummaryHistory.countDocuments({})).toBe(3);
      expect(mockPg.current.rows.size).toBe(3);
      expect(upserts()).toBe(3);
      expect(await discordSummaryHistoryStore().verify()).toMatchObject({
        mongo: 3, pg: 3, missing: 0, differs: 0, extra: 0,
      });
    });

    it('rejects a missing field as save() does, before any write or copy', async () => {
      const error = await recordDiscordSummary(fields({ messageCount: undefined })).catch((e) => e);
      expect(error.name).toBe('ValidationError');
      expect(Object.keys(error.errors)).toEqual(['messageCount']);
      expect(await DiscordSummaryHistory.countDocuments({})).toBe(0);
      expect(mockPg.current.calls).toEqual([]);
    });

    it('a failed copy still resolves, keeps the marker, and repair finishes it', async () => {
      mockPg.current.failNext('upsert');
      await expect(recordDiscordSummary(fields({ content: 'flaky' }))).resolves.toBeUndefined();
      expect(await byContent('flaky')).toMatchObject({ pgVersion: 1, pgPending: 1 });
      expect(mockPg.current.rows.size).toBe(0);

      expect(await discordSummaryHistoryStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      const doc = await byContent('flaky');
      expect(doc.pgPending).toBeUndefined();
      expect(mockPg.current.rows.get(String(doc._id))).toMatchObject({ row: { content: 'flaky' }, version: 1 });
      expect(await discordSummaryHistoryStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('a Postgres that throws on every call never fails the caller', async () => {
      mockPg.current.failNext('upsert', 100);
      mockPg.current.failNext('get', 100);
      await expect(recordDiscordSummary(fields({ content: 'down' }))).resolves.toBeUndefined();
      expect(await byContent('down')).toMatchObject({ pgVersion: 1, pgPending: 1 });
    });

    it('backfill copies summaries written before dual, and verify agrees', async () => {
      delete process.env[ENV];
      await recordDiscordSummary(fields({ content: 'before dual' }));
      process.env[ENV] = mode;
      // A pre-dual document written directly, without timestamps or flags.
      await DiscordSummaryHistory.collection.insertOne({
        integrationId: new Types.ObjectId(),
        summaryType: 'manual',
        content: 'bare',
        messageCount: 1,
        timeRange: { start: START, end: END },
      });
      const store = discordSummaryHistoryStore();
      expect(await store.verify()).toMatchObject({ mongo: 2, pg: 0, missing: 2 });
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
      const bare = await byContent('bare');
      expect(mockPg.current.rows.get(String(bare._id))).toMatchObject({
        row: {
          posted_to_discord: null, posted_to_commonly: null, created_at: null, updated_at: null,
        },
        version: 0,
      });
      const verified = await store.verify();
      expect(verified).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
      expect(verified.checksumPg).toBe(verified.checksumMongo);
    });
  });

  it('the store reads a row back in the shape a lean Mongo read returns', async () => {
    process.env[ENV] = 'dual';
    await recordDiscordSummary(fields({ content: 'round trip' }));
    const doc = await byContent('round trip');
    process.env[ENV] = 'pg-read';
    const read = await discordSummaryHistoryStore().findById(doc._id);
    const { pgVersion, pgPending, __v, ...lean } = doc;
    expect(read).toEqual(lean);
  });

  it('pg: refuses until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    await expect(recordDiscordSummary(fields())).rejects.toThrow(/not supported in pg mode until step 4/);
    expect(await DiscordSummaryHistory.countDocuments({})).toBe(0);
    expect(mockPg.current.calls).toEqual([]);
  });
});
