/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for BillingEvent on real PostgreSQL: migration 0022, and a
 * dual claim then record through the real pgTableAdapter SQL, with racing
 * claims taking the lock once and verify finding both stores equal.
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
const BillingEvent = require('../../models/BillingEvent');
const {
  billingEventStore, claimBillingEvent, recordBillingOutcome,
} = require('../../repositories/billingEventRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(path.join(__dirname, '../../config/migrations/0022_billing_events.sql'), 'utf8');
const ENV = 'STORE_MODE_BILLING_EVENT';
const TYPE = 'customer.subscription.updated';
// Obviously fake ids: no real Stripe event or customer.
const fakeEventId = () => `evt_test_${new Types.ObjectId()}`;

real('BillingEvent on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await BillingEvent.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await BillingEvent.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0022 is a no-op on a second run, and event_id is unique', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
        AND tablename = 'billing_events' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(['billing_events_event_id', 'billing_events_pkey']);
    const insert = (id) => database.pool.query(
      'INSERT INTO billing_events (id, event_id, type, outcome, pg_version) VALUES ($1, $2, $3, $4, 1)',
      [id, 'evt_test_same', TYPE, 'ignored'],
    );
    await insert('a');
    await expect(insert('b')).rejects.toMatchObject({ code: '23505' });
    await expect(database.pool.query(
      'INSERT INTO billing_events (id, type, outcome, pg_version) VALUES ($1, $2, $3, 1)', ['c', TYPE, 'ignored'],
    )).rejects.toMatchObject({ code: '23502' });
  });

  it('dual: racing claims take the lock once; claim then record; verify finds the stores equal', async () => {
    process.env[ENV] = 'dual';
    const eventId = fakeEventId();
    const userId = String(new Types.ObjectId());
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => claimBillingEvent(eventId, TYPE)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await recordBillingOutcome(eventId, {
      outcome: 'applied', detail: 'status=active', customerId: 'cus_test_fake', userId,
    });
    expect(await claimBillingEvent(eventId, TYPE)).toBe(false);

    // An unmapped event: no customer and no user, and neither is written as null in Mongo.
    const unmapped = fakeEventId();
    expect(await claimBillingEvent(unmapped, TYPE)).toBe(true);
    await recordBillingOutcome(unmapped, { outcome: 'unmapped', detail: undefined, customerId: undefined });

    const doc = await BillingEvent.findOne({ eventId }).lean();
    expect(doc).toMatchObject({ outcome: 'applied', pgVersion: 2 });
    const bare = await BillingEvent.findOne({ eventId: unmapped }).lean();
    expect('customerId' in bare).toBe(false);
    const { rows } = await database.pool.query('SELECT * FROM billing_events ORDER BY event_id = $1 DESC', [eventId]);
    expect(rows).toEqual([{
      id: String(doc._id),
      event_id: eventId,
      type: TYPE,
      customer_id: 'cus_test_fake',
      user_id: userId,
      outcome: 'applied',
      detail: 'status=active',
      created_at: doc.createdAt,
      pg_version: 2,
    }, {
      id: String(bare._id),
      event_id: unmapped,
      type: TYPE,
      customer_id: null,
      user_id: null,
      outcome: 'unmapped',
      detail: 'claimed',
      created_at: bare.createdAt,
      pg_version: 2,
    }]);
    const verified = await billingEventStore().verify();
    expect(verified).toMatchObject({
      mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
    });
    expect(verified.checksumPg).toBe(verified.checksumMongo);
  });
});
