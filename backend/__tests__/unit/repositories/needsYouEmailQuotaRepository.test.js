/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for the needs-you email daily cap. The repository's Postgres
// table is the in-memory adapter here; Mongo is real, so the claims' upsert
// and conditional increment race with their production atomicity.
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
const NeedsYouEmailQuota = require('../../../models/NeedsYouEmailQuota');
const { claimEmailSlot, emailQuotaStore } = require('../../../repositories/needsYouEmailQuotaRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_NEEDS_YOU_EMAIL_QUOTA';
const LIMIT = 3;
const DAY = '2026-11-25';

describe('needs-you email quota repository (ADR-034 step 2)', () => {
  let recipient;

  beforeAll(async () => {
    await setupMongoDb();
    await NeedsYouEmailQuota.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    recipient = new Types.ObjectId();
    await NeedsYouEmailQuota.deleteMany({});
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await emailQuotaStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (who = recipient, day = DAY) => NeedsYouEmailQuota.findOne({ recipientUserId: who, day }).lean();
  const rowOf = async (who = recipient, day = DAY) => mockPg.current.rows.get(String((await raw(who, day))._id));
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;
  const STORE_FIELDS = ['_id', 'recipientUserId', 'pgVersion', 'pgPending', 'pgDeleted', '__v'];
  const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !STORE_FIELDS.includes(key)));
  const claims = (n, who = recipient, day = DAY) => Promise.all(
    Array.from({ length: n }, () => claimEmailSlot(who, day, LIMIT)),
  );

  it('declares the table and the id', () => {
    emailQuotaStore();
    expect(mockPg.options).toMatchObject({ table: 'needs_you_email_quotas', idColumn: 'id' });
  });

  it('names the columns 0020 creates, and nothing else, with the (recipient, day) key unique', () => {
    emailQuotaStore();
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0020_needs_you_email_quotas.sql'), 'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|INTEGER)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON needs_you_email_quotas \(recipient_user_id, day\)/);
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 Mongoose calls, with no markers and no Postgres call', async () => {
      // Mongoose adds __v to the update object it was handed, so each call's
      // arguments are recorded as they were passed.
      const passed = (method) => {
        const calls = [];
        const original = NeedsYouEmailQuota[method];
        jest.spyOn(NeedsYouEmailQuota, method).mockImplementation(function record(...args) {
          calls.push(JSON.parse(JSON.stringify(args)));
          return original.apply(this, args);
        });
        return calls;
      };
      const updateOne = passed('updateOne');
      const findOneAndUpdate = passed('findOneAndUpdate');
      const id = String(recipient);

      expect(await claimEmailSlot(recipient, DAY, LIMIT)).toBe(true);
      expect(updateOne).toEqual([
        [{ recipientUserId: id, day: DAY }, { $setOnInsert: { count: 0 } }, { upsert: true }],
      ]);
      expect(findOneAndUpdate).toEqual([
        [{ recipientUserId: id, day: DAY, count: { $lt: LIMIT } }, { $inc: { count: 1 } }, { new: true }],
      ]);

      // Concurrent: any one of the three may be the one that finds the day full.
      expect((await claims(LIMIT)).sort()).toEqual([false, true, true]);
      const doc = await raw();
      expect(doc.count).toBe(LIMIT);
      expect(doc.pgVersion).toBeUndefined();
      expect(doc.pgPending).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('ignores a duplicate key on the day\'s upsert and still contends for a slot', async () => {
      const duplicate = Object.assign(new Error('dup'), { code: 11000 });
      jest.spyOn(NeedsYouEmailQuota, 'updateOne').mockRejectedValueOnce(duplicate);
      await NeedsYouEmailQuota.create({ recipientUserId: recipient, day: DAY, count: 0 });
      expect(await claimEmailSlot(recipient, DAY, LIMIT)).toBe(true);
      expect((await raw()).count).toBe(1);
    });

    it('passes through an error that is not a duplicate key', async () => {
      jest.spyOn(NeedsYouEmailQuota, 'updateOne').mockRejectedValueOnce(new Error('mongo down'));
      const findOneAndUpdate = jest.spyOn(NeedsYouEmailQuota, 'findOneAndUpdate');
      await expect(claimEmailSlot(recipient, DAY, LIMIT)).rejects.toThrow('mongo down');
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('gives the same outcomes and document as mongo, and copies each change once', async () => {
      const mongoRecipient = new Types.ObjectId();
      delete process.env[ENV];
      const mongoOutcomes = [];
      for (let i = 0; i < LIMIT + 1; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- in order
        mongoOutcomes.push(await claimEmailSlot(mongoRecipient, DAY, LIMIT));
      }
      process.env[ENV] = mode;
      const outcomes = [];
      for (let i = 0; i < LIMIT + 1; i += 1) {
        // A hex string casts to the same ObjectId, as it does in mongo.
        // eslint-disable-next-line no-await-in-loop -- in order
        outcomes.push(await claimEmailSlot(i % 2 ? String(recipient) : recipient, DAY, LIMIT));
      }
      expect(outcomes).toEqual([true, true, true, false]);
      expect(outcomes).toEqual(mongoOutcomes);

      const doc = await raw();
      expect(payload(doc)).toEqual(payload(await raw(mongoRecipient)));
      expect(doc.recipientUserId).toEqual(recipient);
      // The insert and three slots: four versions, four copies; the overflow writes nothing.
      expect(doc.pgVersion).toBe(4);
      expect(doc.pgPending).toBeUndefined();
      expect(upserts()).toBe(4);
      expect(await rowOf()).toEqual({
        row: {
          id: String(doc._id), recipient_user_id: String(recipient), day: DAY, count: LIMIT,
        },
        version: 4,
      });
      expect(await emailQuotaStore().verify()).toMatchObject({ missing: 1, differs: 0, extra: 0 });
    });

    it('a fresh day: ten racing claims take exactly the limit, one insert and no fourth', async () => {
      const outcomes = await claims(10);
      expect(outcomes.filter(Boolean)).toHaveLength(LIMIT);
      expect(await NeedsYouEmailQuota.countDocuments({})).toBe(1);
      expect(await raw()).toMatchObject({ count: LIMIT, pgVersion: LIMIT + 1 });
      expect(upserts()).toBe(LIMIT + 1);
      expect(await rowOf()).toMatchObject({ row: { count: LIMIT }, version: LIMIT + 1 });
      expect(await claimEmailSlot(recipient, DAY, LIMIT)).toBe(false);
      expect(await emailQuotaStore().verify()).toMatchObject({
        mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
      });
    });

    it('a partly used day: racing claims take only the slots left', async () => {
      expect(await claims(2)).toEqual([true, true]);
      const copies = upserts();
      const outcomes = await claims(10);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await raw()).toMatchObject({ count: LIMIT, pgVersion: LIMIT + 1 });
      expect(upserts()).toBe(copies + 1);
      expect(await emailQuotaStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('a full day writes and copies nothing; another day and another recipient start afresh', async () => {
      expect((await claims(LIMIT)).every(Boolean)).toBe(true);
      const before = await raw();
      const copies = upserts();
      expect(await claims(5)).toEqual([false, false, false, false, false]);
      expect(await raw()).toEqual(before);
      expect(upserts()).toBe(copies);

      expect(await claimEmailSlot(recipient, '2026-11-26', LIMIT)).toBe(true);
      const other = new Types.ObjectId();
      expect(await claimEmailSlot(other, DAY, LIMIT)).toBe(true);
      expect(await raw(recipient, '2026-11-26')).toMatchObject({ count: 1 });
      expect(await raw(other)).toMatchObject({ count: 1 });
      expect(await emailQuotaStore().verify()).toMatchObject({
        mongo: 3, pg: 3, missing: 0, differs: 0, extra: 0,
      });
    });

    it('a failed copy leaves the slot taken and the marker for repair', async () => {
      expect(await claimEmailSlot(recipient, DAY, LIMIT)).toBe(true);
      mockPg.current.failNext('upsert');
      expect(await claimEmailSlot(recipient, DAY, LIMIT)).toBe(true);
      expect(await raw()).toMatchObject({ count: 2, pgVersion: 3, pgPending: 3 });
      expect(await rowOf()).toMatchObject({ row: { count: 1 }, version: 2 });
      expect(await emailQuotaStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect((await raw()).pgPending).toBeUndefined();
      expect(await rowOf()).toMatchObject({ row: { count: 2 }, version: 3 });
      // The cap counted the slot whose copy was behind: one is left.
      expect((await claims(2)).filter(Boolean)).toHaveLength(1);
      expect(await rowOf()).toMatchObject({ row: { count: LIMIT }, version: 4 });
      expect(await emailQuotaStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('backfill copies quotas written before dual, and verify agrees', async () => {
      const mongoRecipient = new Types.ObjectId();
      delete process.env[ENV];
      expect(await claims(2, mongoRecipient)).toEqual([true, true]);
      process.env[ENV] = mode;
      // A pre-dual document written directly.
      await NeedsYouEmailQuota.collection.insertOne({ recipientUserId: recipient, day: DAY, count: LIMIT });
      const store = emailQuotaStore();
      expect(await store.verify()).toMatchObject({ mongo: 2, pg: 0, missing: 2 });
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
      expect(await rowOf(mongoRecipient)).toMatchObject({ row: { count: 2 }, version: 0 });
      expect(await store.verify()).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
      // A dual claim on a backfilled quota lands at the next version, and a full one stays full.
      expect(await claimEmailSlot(mongoRecipient, DAY, LIMIT)).toBe(true);
      expect(await claimEmailSlot(recipient, DAY, LIMIT)).toBe(false);
      expect(await rowOf(mongoRecipient)).toMatchObject({ row: { count: LIMIT }, version: 1 });
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });
  });

  it('pg: a claim refuses until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    await expect(claimEmailSlot(recipient, DAY, LIMIT)).rejects.toThrow(/not supported in pg mode until step 4/);
    expect(await NeedsYouEmailQuota.countDocuments({})).toBe(0);
    expect(mockPg.current.calls).toEqual([]);
  });
});
