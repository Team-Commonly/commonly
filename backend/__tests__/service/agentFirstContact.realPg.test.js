/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for AgentFirstContact on real PostgreSQL: migration 0017, the
 * repository's real pgTableAdapter SQL (the JSONB greeting map, the version
 * guard), and verify agreeing with Mongo after both claims.
 */
const fs = require('fs');
const path = require('path');

const mockDb = { pool: null };
jest.mock('../../config/db-pg', () => ({
  pool: { query: (...args) => mockDb.pool.query(...args) },
}));

const mongoose = require('mongoose');
const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const AgentFirstContact = require('../../models/AgentFirstContact');
const {
  claimFirstContact, claimPodGreeting, firstContactStore,
} = require('../../repositories/agentFirstContactRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0017_agent_first_contacts.sql'), 'utf8',
);
const ENV = 'STORE_MODE_AGENT_FIRST_CONTACT';
const DAY = 24 * 60 * 60 * 1000;
const at = (day) => new Date(Date.UTC(2026, 10, day));

real('AgentFirstContact on real PostgreSQL (ADR-034 step 2)', () => {
  let database;
  beforeAll(async () => {
    await setupMongoDb();
    await AgentFirstContact.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await AgentFirstContact.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0017 is a no-op on a second run and creates exactly the planned columns and unique key', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(`SELECT column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agent_first_contacts'
      ORDER BY ordinal_position`);
    expect(rows).toEqual([
      { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'user_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'agent_name', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'instance_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'first_pod_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'greeted_at_by_pod', data_type: 'jsonb', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'pg_version', data_type: 'integer', is_nullable: 'NO' },
    ]);
    const insert = `INSERT INTO agent_first_contacts (id, user_id, agent_name, instance_id, first_pod_id, pg_version)
      VALUES ($1, 'u', 'scout', 'default', 'p', 1)`;
    await database.pool.query(insert, ['a']);
    await expect(database.pool.query(insert, ['b'])).rejects.toMatchObject({ code: '23505' });
  });

  it('dual: both claims land in both stores, and verify finds them equal', async () => {
    process.env[ENV] = 'dual';
    const identity = { userId: new mongoose.Types.ObjectId(), agentName: 'scout', instanceId: 'default' };
    const pod = new mongoose.Types.ObjectId();
    const greet = (now) => claimPodGreeting(identity, pod, now, new Date(now.getTime() - 30 * DAY));
    expect(await claimFirstContact(identity, { firstPodId: pod, createdAt: at(1) })).toEqual({ inserted: true });
    expect(await claimFirstContact(identity, { firstPodId: pod, createdAt: at(1) })).toEqual({ inserted: false });
    expect(await greet(at(2))).toBe(true);
    expect(await greet(at(3))).toBe(false);
    const doc = await AgentFirstContact.findOne(identity).lean();
    const { rows } = await database.pool.query('SELECT * FROM agent_first_contacts');
    expect(rows).toEqual([{
      id: String(doc._id),
      user_id: String(identity.userId),
      agent_name: 'scout',
      instance_id: 'default',
      first_pod_id: String(pod),
      greeted_at_by_pod: { [String(pod)]: at(2).toISOString() },
      created_at: doc.createdAt,
      pg_version: 2,
    }]);
    const verified = await firstContactStore().verify();
    expect(verified).toMatchObject({
      mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
    });
    expect(verified.checksumPg).toBe(verified.checksumMongo);
  });

  it('backfill copies a pre-dual marker with an empty map, and verify agrees', async () => {
    const identity = { userId: new mongoose.Types.ObjectId(), agentName: 'scout', instanceId: 'default' };
    await AgentFirstContact.collection.insertOne({
      ...identity, firstPodId: new mongoose.Types.ObjectId(), createdAt: at(1),
    });
    process.env[ENV] = 'dual';
    expect(await firstContactStore().backfill({ dryRun: false })).toMatchObject({ scanned: 1, inserted: 1 });
    expect((await database.pool.query('SELECT greeted_at_by_pod, pg_version FROM agent_first_contacts')).rows)
      .toEqual([{ greeted_at_by_pod: {}, pg_version: 0 }]);
    expect(await firstContactStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
  });
});
