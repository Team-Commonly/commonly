/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for AgentProviderKey on real PostgreSQL: migration 0026 run
 * twice, then every caller shape in dual and pg-read through the real
 * pgTableAdapter SQL (the $inc upsert, the generation-locked commit, the
 * stamp, the remove's pre-image), racing first sets, a pg-read of the binding
 * with its ObjectIds, and verify finding both stores equal.
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
const AgentProviderKey = require('../../models/AgentProviderKey');
const {
  providerKeyStore, findProviderKey, findProviderKeyBySecretRef, clearProviderKey, bumpProviderKeyGeneration,
  commitProviderKey, markProviderKeyUsed,
} = require('../../repositories/agentProviderKeyRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0026_agent_provider_keys.sql'), 'utf8',
);
const ENV = 'STORE_MODE_AGENT_PROVIDER_KEY';
const at = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const DEST = { providerId: 'test-provider', baseURL: 'https://api.example.com/v1' };
const ref = () => new Types.ObjectId().toHexString();
const newOwner = () => ({ agentUserId: new Types.ObjectId(), ownerUserId: String(new Types.ObjectId()) });
const commit = (secretRef, setBy, when) => ({
  secretRef, providerId: DEST.providerId, baseURL: DEST.baseURL, setAt: when, setBy, lastUsedAt: null,
});
const MARKERS = ['__v', 'pgVersion', 'pgPending', 'pgDeleted'];
const unmarked = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !MARKERS.includes(k)));

real('AgentProviderKey on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await AgentProviderKey.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await AgentProviderKey.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  const row = async (id) => (await database.pool.query(
    'SELECT * FROM agent_provider_keys WHERE id = $1', [String(id)],
  )).rows[0];

  it('0026 is a no-op on a second run, and agent_user_id is unique', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agent_provider_keys' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['agent_user_id', 'base_url', 'created_at', 'generation', 'id',
      'last_used_at', 'owner_user_id', 'pg_version', 'provider_id', 'secret_ref', 'set_at', 'set_by', 'updated_at']);
    expect(rows.filter((r) => r.is_nullable === 'NO').map((r) => r.column_name)).toEqual(['id', 'pg_version']);
    await database.pool.query("INSERT INTO agent_provider_keys (id, agent_user_id, pg_version) VALUES ('a', 'u', 1)");
    await expect(database.pool.query(
      "INSERT INTO agent_provider_keys (id, agent_user_id, pg_version) VALUES ('b', 'u', 1)",
    )).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['dual', 'pg-read'])('%s: every caller shape lands in both stores, and verify agrees', async (mode) => {
    process.env[ENV] = mode;
    const store = providerKeyStore();
    const owner = newOwner();
    const [first, second] = [ref(), ref()];

    expect(await findProviderKey(owner)).toBeNull();
    expect(await clearProviderKey(owner)).toBeNull();
    const started = await bumpProviderKeyGeneration(owner, DEST);
    expect(started).toMatchObject({ generation: 1, secretRef: null });
    expect(await row(started._id)).toMatchObject({ generation: 1, secret_ref: null, pg_version: 1 });
    expect(await commitProviderKey(owner, 1, commit(first, owner.ownerUserId, at(0))))
      .toMatchObject({ generation: 1, secretRef: first });
    // A stale generation loses on Mongo, and Postgres keeps the winner.
    expect(await commitProviderKey(owner, 0, commit(second, owner.ownerUserId, at(1)))).toBeNull();
    expect(await row(started._id)).toMatchObject({
      generation: 1, secret_ref: first, set_at: at(0), set_by: owner.ownerUserId, pg_version: 2,
    });

    const read = await findProviderKey(owner);
    expect(read).toEqual(unmarked(await AgentProviderKey.findById(started._id).lean()));
    expect(read.setBy).toBeInstanceOf(Types.ObjectId);
    expect(await markProviderKeyUsed(read, at(2))).toBe(true);
    expect(await markProviderKeyUsed({ ...read, generation: 0 }, at(3))).toBe(false);
    expect(await row(started._id)).toMatchObject({ last_used_at: at(2), pg_version: 3 });
    expect(await findProviderKeyBySecretRef(first)).toEqual({ _id: started._id, secretRef: first });

    const next = await bumpProviderKeyGeneration(owner, DEST);
    expect(next).toMatchObject({ generation: 2, secretRef: first });
    await commitProviderKey(owner, 2, commit(second, owner.ownerUserId, at(4)));
    const removed = await clearProviderKey(owner);
    expect(removed).toMatchObject({ generation: 2, secretRef: second });
    expect(await row(started._id)).toMatchObject({
      generation: 3, secret_ref: null, set_at: null, set_by: null, last_used_at: null, pg_version: 6,
    });
    expect(await findProviderKeyBySecretRef(second)).toBeNull();

    // Racing first sets on another agent: each resolved call has its own generation.
    const racer = newOwner();
    const gens = (await Promise.all(Array.from({ length: 4 }, () => bumpProviderKeyGeneration(racer, DEST))))
      .map((doc) => doc.generation).sort();
    expect(gens).toEqual([1, 2, 3, 4]);
    const raced = await AgentProviderKey.findOne({ agentUserId: racer.agentUserId }).lean();
    expect(await row(raced._id)).toMatchObject({ generation: 4, pg_version: raced.pgVersion });

    expect(await store.verify()).toMatchObject({
      mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
    });
  });

  it('backfill copies bindings written in mongo mode, ObjectIds included, and verify agrees', async () => {
    const owner = newOwner();
    const secretRef = ref();
    const { generation, _id: id } = await bumpProviderKeyGeneration(owner, DEST);
    await commitProviderKey(owner, generation, commit(secretRef, owner.ownerUserId, at(0)));
    process.env[ENV] = 'dual';
    const store = providerKeyStore();
    expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 1, inserted: 1 });
    expect(await row(id)).toMatchObject({
      agent_user_id: String(owner.agentUserId), secret_ref: secretRef, set_by: owner.ownerUserId, pg_version: 0,
    });
    expect(await store.verify()).toMatchObject({
      mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
    });
  });
});
