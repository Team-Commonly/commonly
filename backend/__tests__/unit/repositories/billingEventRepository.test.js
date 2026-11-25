/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for the Stripe webhook idempotency marker. The repository's
// Postgres table is the in-memory adapter here; Mongo is real, so racing
// claims meet the production unique index on eventId.
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
const BillingEvent = require('../../../models/BillingEvent');
const {
  billingEventStore, claimBillingEvent, recordBillingOutcome,
} = require('../../../repositories/billingEventRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_BILLING_EVENT';
const TYPE = 'customer.subscription.updated';
// Obviously fake ids: no real Stripe event or customer.
const fakeEventId = () => `evt_test_${new Types.ObjectId()}`;
const CUSTOMER = 'cus_test_fake';

describe('billing event repository (ADR-034 step 2)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await BillingEvent.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await BillingEvent.deleteMany({});
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await billingEventStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (eventId) => BillingEvent.findOne({ eventId }).lean();
  const rowOf = async (eventId) => mockPg.current.rows.get(String((await raw(eventId))._id));
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;
  const STORE_FIELDS = ['_id', 'eventId', 'createdAt', 'pgVersion', 'pgPending', 'pgDeleted'];
  const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !STORE_FIELDS.includes(key)));
  // The service's record step, as billingService.handleEvent builds it.
  const outcome = (over = {}) => ({
    outcome: 'applied', detail: 'status=active', customerId: CUSTOMER, ...over,
  });

  it('declares the table and the id', () => {
    billingEventStore();
    expect(mockPg.options).toMatchObject({ table: 'billing_events', idColumn: 'id' });
  });

  it('names the columns 0022 creates, and nothing else, with event_id unique', () => {
    billingEventStore();
    const sql = fs.readFileSync(path.join(__dirname, '../../../config/migrations/0022_billing_events.sql'), 'utf8');
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|INTEGER|TIMESTAMPTZ)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON billing_events \(event_id\)/);
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 create and updateOne, with no markers and no Postgres call', async () => {
      // Each call's arguments as they were passed, undefined values kept.
      const createArgs = [];
      const updateArgs = [];
      const { create, updateOne } = BillingEvent;
      jest.spyOn(BillingEvent, 'create').mockImplementation(function record(...args) {
        createArgs.push([{ ...args[0] }]);
        return create.apply(this, args);
      });
      jest.spyOn(BillingEvent, 'updateOne').mockImplementation(function record(...args) {
        updateArgs.push([{ ...args[0] }, { $set: { ...args[1].$set } }, ...args.slice(2)]);
        return updateOne.apply(this, args);
      });
      const eventId = fakeEventId();
      const userId = String(new Types.ObjectId());

      expect(await claimBillingEvent(eventId, TYPE)).toBe(true);
      expect(createArgs).toEqual([[{
        eventId, type: TYPE, outcome: 'ignored', detail: 'claimed',
      }]]);
      await recordBillingOutcome(eventId, outcome({ userId }));
      expect(updateArgs).toEqual([[{ eventId }, { $set: outcome({ userId }) }]]);

      const doc = await raw(eventId);
      expect(doc).toMatchObject({
        eventId, type: TYPE, outcome: 'applied', detail: 'status=active', customerId: CUSTOMER,
      });
      expect(doc.userId).toEqual(new Types.ObjectId(userId));
      expect(doc.pgVersion).toBeUndefined();
      expect(doc.pgPending).toBeUndefined();
      expect(await claimBillingEvent(eventId, TYPE)).toBe(false);
      expect(await BillingEvent.countDocuments({})).toBe(1);
      expect(mockPg.current.calls).toEqual([]);
    });

    it('passes an undefined customerId and detail through as passed, and Mongoose writes neither', async () => {
      const updateArgs = [];
      const { updateOne } = BillingEvent;
      jest.spyOn(BillingEvent, 'updateOne').mockImplementation(function record(...args) {
        updateArgs.push({ ...args[1].$set });
        return updateOne.apply(this, args);
      });
      const eventId = fakeEventId();
      await claimBillingEvent(eventId, TYPE);
      await recordBillingOutcome(eventId, { outcome: 'ignored', detail: undefined, customerId: undefined });
      // The keys reach Mongoose with undefined values, exactly as the service built them.
      expect(Object.keys(updateArgs[0]).sort()).toEqual(['customerId', 'detail', 'outcome']);
      expect(updateArgs[0].customerId).toBeUndefined();
      const doc = await raw(eventId);
      expect('customerId' in doc).toBe(false);
      // The claim's detail is kept, not overwritten with null.
      expect(doc).toMatchObject({ outcome: 'ignored', detail: 'claimed' });
    });

    it('passes through a claim error that is not a duplicate key', async () => {
      jest.spyOn(BillingEvent, 'create').mockRejectedValueOnce(new Error('mongo down'));
      await expect(claimBillingEvent(fakeEventId(), TYPE)).rejects.toThrow('mongo down');
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('gives the same outcomes and document as mongo, and copies each write once', async () => {
      const userId = String(new Types.ObjectId());
      const mongoEvent = fakeEventId();
      delete process.env[ENV];
      const mongoOutcomes = [await claimBillingEvent(mongoEvent, TYPE)];
      await recordBillingOutcome(mongoEvent, outcome({ userId }));
      mongoOutcomes.push(await claimBillingEvent(mongoEvent, TYPE));
      process.env[ENV] = mode;

      const eventId = fakeEventId();
      const outcomes = [await claimBillingEvent(eventId, TYPE)];
      await recordBillingOutcome(eventId, outcome({ userId }));
      outcomes.push(await claimBillingEvent(eventId, TYPE));
      expect(outcomes).toEqual([true, false]);
      expect(outcomes).toEqual(mongoOutcomes);

      const doc = await raw(eventId);
      expect(payload(doc)).toEqual(payload(await raw(mongoEvent)));
      expect(doc.userId).toEqual(new Types.ObjectId(userId));
      // The claim and the record: two versions, two copies; the duplicate writes nothing.
      expect(doc.pgVersion).toBe(2);
      expect(doc.pgPending).toBeUndefined();
      expect(upserts()).toBe(2);
      expect(await rowOf(eventId)).toEqual({
        row: {
          id: String(doc._id),
          event_id: eventId,
          type: TYPE,
          customer_id: CUSTOMER,
          user_id: userId,
          outcome: 'applied',
          detail: 'status=active',
          created_at: doc.createdAt,
        },
        version: 2,
      });
      // The mongo-mode document was never copied.
      expect(await billingEventStore().verify()).toMatchObject({
        mongo: 2, pg: 1, missing: 1, differs: 0, extra: 0,
      });
    });

    it('an undefined customerId or detail writes nothing, in Mongo or the row, as in mongo', async () => {
      const eventId = fakeEventId();
      await claimBillingEvent(eventId, TYPE);
      await recordBillingOutcome(eventId, { outcome: 'unmapped', detail: undefined, customerId: undefined });
      const doc = await raw(eventId);
      expect('customerId' in doc).toBe(false);
      expect('userId' in doc).toBe(false);
      expect(doc).toMatchObject({ outcome: 'unmapped', detail: 'claimed', pgVersion: 2 });
      expect(await rowOf(eventId)).toMatchObject({
        row: {
          customer_id: null, user_id: null, outcome: 'unmapped', detail: 'claimed',
        },
        version: 2,
      });
      // A later record without a customer keeps the one already set.
      await recordBillingOutcome(eventId, outcome());
      await recordBillingOutcome(eventId, { outcome: 'applied', detail: 'again', customerId: undefined });
      expect(await raw(eventId)).toMatchObject({ customerId: CUSTOMER, detail: 'again' });
      expect(await rowOf(eventId)).toMatchObject({ row: { customer_id: CUSTOMER, detail: 'again' }, version: 4 });
      expect(await billingEventStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('stores a value that looks like a field path verbatim', async () => {
      const eventId = fakeEventId();
      await claimBillingEvent(eventId, TYPE);
      await recordBillingOutcome(eventId, outcome({ detail: '$detail', customerId: '$type' }));
      expect(await raw(eventId)).toMatchObject({ detail: '$detail', customerId: '$type' });
      expect(await rowOf(eventId)).toMatchObject({ row: { detail: '$detail', customer_id: '$type' } });
    });

    it('two concurrent claims of one event id: exactly one claims, one document, one row', async () => {
      const eventId = fakeEventId();
      const outcomes = await Promise.all([claimBillingEvent(eventId, TYPE), claimBillingEvent(eventId, TYPE)]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await BillingEvent.countDocuments({ eventId })).toBe(1);
      expect(mockPg.current.rows.size).toBe(1);
      expect(upserts()).toBe(1);

      const many = await Promise.all(Array.from({ length: 10 }, () => claimBillingEvent(eventId, TYPE)));
      expect(many.filter(Boolean)).toHaveLength(0);
      const fresh = fakeEventId();
      const racing = await Promise.all(Array.from({ length: 10 }, () => claimBillingEvent(fresh, TYPE)));
      expect(racing.filter(Boolean)).toHaveLength(1);
      expect(await BillingEvent.countDocuments({})).toBe(2);
      expect(mockPg.current.rows.size).toBe(2);
      expect(await billingEventStore().verify()).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
    });

    it('a failed copy after a claim still claims, with the marker for repair; a retry is a duplicate', async () => {
      const eventId = fakeEventId();
      mockPg.current.failNext('upsert');
      expect(await claimBillingEvent(eventId, TYPE)).toBe(true);
      expect(await raw(eventId)).toMatchObject({ pgVersion: 1, pgPending: 1 });
      expect(mockPg.current.rows.size).toBe(0);
      // Stripe's retry of the same event must not be processed again.
      expect(await claimBillingEvent(eventId, TYPE)).toBe(false);

      expect(await billingEventStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect((await raw(eventId)).pgPending).toBeUndefined();
      expect(await rowOf(eventId)).toMatchObject({ row: { event_id: eventId, detail: 'claimed' }, version: 1 });
      expect(await billingEventStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('a Postgres that throws on every call never loses or doubles a claim', async () => {
      const eventId = fakeEventId();
      mockPg.current.failNext('upsert', 100);
      mockPg.current.failNext('get', 100);
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => claimBillingEvent(eventId, TYPE)));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      await expect(recordBillingOutcome(eventId, outcome())).resolves.toBeUndefined();
      expect(await raw(eventId)).toMatchObject({ outcome: 'applied', pgVersion: 2, pgPending: 2 });
      expect(await BillingEvent.countDocuments({})).toBe(1);
    });

    it('a failed copy of a record leaves the outcome in Mongo and the marker for repair', async () => {
      const eventId = fakeEventId();
      await claimBillingEvent(eventId, TYPE);
      mockPg.current.failNext('upsert');
      await recordBillingOutcome(eventId, outcome());
      expect(await raw(eventId)).toMatchObject({ outcome: 'applied', pgVersion: 2, pgPending: 2 });
      expect(await rowOf(eventId)).toMatchObject({ row: { outcome: 'ignored' }, version: 1 });
      expect(await billingEventStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect(await rowOf(eventId)).toMatchObject({ row: { outcome: 'applied', customer_id: CUSTOMER }, version: 2 });
      expect(await billingEventStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('recording an event that was never claimed writes and copies nothing', async () => {
      await recordBillingOutcome(fakeEventId(), outcome());
      expect(await BillingEvent.countDocuments({})).toBe(0);
      expect(upserts()).toBe(0);
    });

    it('backfill copies events written before dual, and verify agrees', async () => {
      const mongoEvent = fakeEventId();
      delete process.env[ENV];
      await claimBillingEvent(mongoEvent, TYPE);
      await recordBillingOutcome(mongoEvent, outcome({ userId: String(new Types.ObjectId()) }));
      process.env[ENV] = mode;
      // A pre-dual document written directly, without timestamps or optional fields.
      const bare = fakeEventId();
      await BillingEvent.collection.insertOne({ eventId: bare, type: TYPE, outcome: 'ignored' });
      const store = billingEventStore();
      expect(await store.verify()).toMatchObject({ mongo: 2, pg: 0, missing: 2 });
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
      expect(await rowOf(bare)).toMatchObject({
        row: {
          customer_id: null, user_id: null, detail: null, created_at: null,
        },
        version: 0,
      });
      expect(await store.verify()).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
      // A backfilled event is still a duplicate, and a dual record lands at the next version.
      expect(await claimBillingEvent(mongoEvent, TYPE)).toBe(false);
      await recordBillingOutcome(bare, outcome({ outcome: 'error', detail: 'late' }));
      expect(await rowOf(bare)).toMatchObject({ row: { outcome: 'error', detail: 'late' }, version: 1 });
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });
  });

  it('pg: a claim and a record refuse until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    const eventId = fakeEventId();
    await expect(claimBillingEvent(eventId, TYPE)).rejects.toThrow(/not supported in pg mode until step 4/);
    await expect(recordBillingOutcome(eventId, outcome())).rejects.toThrow(/not supported in pg mode until step 4/);
    expect(await BillingEvent.countDocuments({})).toBe(0);
    expect(mockPg.current.calls).toEqual([]);
  });
});
