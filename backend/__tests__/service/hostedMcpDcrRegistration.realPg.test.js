/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for HostedMcpDcrRegistration on real PostgreSQL: migration
 * 0027 run twice with its two unique indexes, then every caller shape in dual
 * and pg-read through the real pgTableAdapter SQL (the $setOnInsert claim, a
 * retire by id and by entry, the refusal's pre-image, the ask claim under $or
 * and ranges), racing first registrations, racing refusals and racing asks,
 * pg mode reading the rows back, and verify finding both stores equal.
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
const Model = require('../../models/HostedMcpDcrRegistration');
const {
  dcrRegistrationStore, findCurrentDcrRegistration, findUsableDcrRegistration, findDcrRegistrationSecretOwner,
  listCurrentDcrRegistrations, claimCurrentDcrRegistration, retireDcrRegistrationById,
  retireCurrentDcrRegistration, refuseDcrRegistration, claimDcrAsk,
} = require('../../repositories/hostedMcpDcrRegistrationRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0027_hosted_mcp_dcr_registrations.sql'), 'utf8',
);
const ENV = 'STORE_MODE_HOSTED_MCP_DCR_REGISTRATION';
const INTERVAL = 10 * 60 * 1000;
const CALLBACK = 'https://api.example.test/callback';
const ENTRY = { id: 'close', issuer: 'https://auth.example.test' };
const ref = () => new Types.ObjectId().toHexString();
const insert = (clientId) => ({
  _id: new Types.ObjectId(),
  clientId,
  redirectUri: CALLBACK,
  tokenEndpointAuthMethod: 'client_secret_post',
  clientSecretRef: ref(),
  clientSecretExpiresAt: new Date('2027-01-01T00:00:00Z'),
});
const later = (k = 2) => new Date(Date.now() + k * INTERVAL);
const MARKERS = ['__v', 'pgVersion', 'pgPending', 'pgDeleted'];
const unmarked = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !MARKERS.includes(k)));

real('HostedMcpDcrRegistration on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await Model.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await Model.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  const row = async (id) => (await database.pool.query(
    'SELECT * FROM hosted_mcp_dcr_registrations WHERE id = $1', [String(id)],
  )).rows[0];

  it('0027 is a no-op on a second run, with one current client per entry and one row per client', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'hosted_mcp_dcr_registrations' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['asked_at', 'client_id', 'client_secret_expires_at',
      'client_secret_ref', 'created_at', 'current', 'entry_id', 'id', 'issuer', 'pg_version', 'redirect_uri',
      'refused_at', 'retired_at', 'token_endpoint_auth_method', 'updated_at']);
    expect(rows.filter((r) => r.is_nullable === 'NO').map((r) => r.column_name)).toEqual(['id', 'pg_version']);
    const add = (id, clientId, current) => database.pool.query(
      `INSERT INTO hosted_mcp_dcr_registrations (id, entry_id, issuer, client_id, current, pg_version)
        VALUES ($1, 'e', 'i', $2, $3, 1)`, [id, clientId, current],
    );
    await add('a', 'c1', true);
    await add('b', 'c2', false);
    await add('c', 'c3', false);
    await expect(add('d', 'c4', true)).rejects.toMatchObject({ code: '23505' });
    await expect(add('e', 'c2', false)).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['dual', 'pg-read'])('%s: every caller shape lands in both stores, and verify agrees', async (mode) => {
    process.env[ENV] = mode;
    const store = dcrRegistrationStore();
    const first = insert('client-a');

    expect(await findCurrentDcrRegistration(ENTRY)).toBeNull();
    expect(await claimCurrentDcrRegistration(ENTRY, first)).toMatchObject({ _id: first._id, current: true });
    expect(await row(first._id)).toMatchObject({
      client_id: 'client-a', client_secret_ref: first.clientSecretRef, current: true,
      client_secret_expires_at: first.clientSecretExpiresAt, token_endpoint_auth_method: 'client_secret_post',
      pg_version: 1,
    });
    // A second claim finds the winner and writes nothing.
    expect(await claimCurrentDcrRegistration(ENTRY, insert('client-b'))).toMatchObject({ _id: first._id });
    expect(await Model.countDocuments({})).toBe(1);
    expect((await row(first._id)).pg_version).toBe(1);

    expect(await findCurrentDcrRegistration(ENTRY)).toEqual(unmarked(await Model.findById(first._id).lean()));
    expect(await findUsableDcrRegistration(ENTRY, 'client-a')).toMatchObject({ _id: first._id });
    const now = later();
    expect(await claimDcrAsk(ENTRY, 'client-a', now, INTERVAL)).toMatchObject({ askedAt: now });
    expect(await claimDcrAsk(ENTRY, 'client-a', now, INTERVAL)).toBeNull();
    expect(await row(first._id)).toMatchObject({ asked_at: now, pg_version: 2 });

    expect(await refuseDcrRegistration(ENTRY, 'client-a', now)).toMatchObject({ refusedAt: null, current: true });
    expect(await refuseDcrRegistration(ENTRY, 'client-a', now)).toBeNull();
    expect(await row(first._id)).toMatchObject({ refused_at: now, retired_at: now, current: false, pg_version: 3 });
    expect(await findUsableDcrRegistration(ENTRY, 'client-a')).toBeNull();
    expect(await findDcrRegistrationSecretOwner(first._id)).toEqual({
      _id: first._id, refusedAt: now, clientSecretRef: first.clientSecretRef,
    });

    // The partial unique index admits the next current client once the first is not.
    const second = insert('client-c');
    expect(await claimCurrentDcrRegistration(ENTRY, second)).toMatchObject({ _id: second._id });
    await retireDcrRegistrationById(second._id, now);
    expect(await row(second._id)).toMatchObject({ current: false, retired_at: now, pg_version: 2 });
    const third = insert('client-d');
    await claimCurrentDcrRegistration(ENTRY, third);
    expect(await retireCurrentDcrRegistration(ENTRY, 'client-x', now)).toBe(false);
    expect((await listCurrentDcrRegistrations()).map((doc) => doc.clientId)).toEqual(['client-d']);
    expect(await retireCurrentDcrRegistration(ENTRY, undefined, now)).toBe(true);
    expect(await row(third._id)).toMatchObject({ current: false, pg_version: 2 });

    expect(await store.verify()).toMatchObject({
      mongo: 3, pg: 3, missing: 0, differs: 0, extra: 0,
    });
  });

  it.each(['dual', 'pg-read'])('%s: racing claims each have exactly one winner, in both stores', async (mode) => {
    process.env[ENV] = mode;
    const tries = Array.from({ length: 6 }, (_, i) => insert(`client-${i}`));
    const won = await Promise.all(tries.map((fields) => claimCurrentDcrRegistration(ENTRY, fields)));
    expect(new Set(won.map((doc) => String(doc._id))).size).toBe(1);
    const winner = won[0];
    expect(await Model.countDocuments({})).toBe(1);
    const { rows } = await database.pool.query('SELECT id, current FROM hosted_mcp_dcr_registrations');
    expect(rows).toEqual([{ id: String(winner._id), current: true }]);

    const now = later();
    const asks = await Promise.all(Array.from({ length: 5 }, () => claimDcrAsk(ENTRY, winner.clientId, now, INTERVAL)));
    expect(asks.filter(Boolean)).toHaveLength(1);
    const refusals = await Promise.all(Array.from({ length: 5 }, () => refuseDcrRegistration(ENTRY, winner.clientId, now)));
    expect(refusals.filter(Boolean)).toHaveLength(1);
    const doc = await Model.findById(winner._id).lean();
    expect(await row(winner._id)).toMatchObject({ refused_at: now, current: false, pg_version: doc.pgVersion });
    expect(await dcrRegistrationStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
  });

  it('backfill copies registrations written in mongo mode, and pg reads them back from Postgres', async () => {
    const current = insert('client-a');
    await claimCurrentDcrRegistration(ENTRY, current);
    const old = insert('client-old');
    await claimCurrentDcrRegistration({ id: 'other', issuer: ENTRY.issuer }, old);
    await refuseDcrRegistration({ id: 'other', issuer: ENTRY.issuer }, 'client-old', new Date('2026-11-01T00:00:00Z'));
    process.env[ENV] = 'dual';
    const store = dcrRegistrationStore();
    expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
    expect(await row(current._id)).toMatchObject({ client_id: 'client-a', current: true, pg_version: 0 });
    expect(await store.verify()).toMatchObject({
      mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
    });

    process.env[ENV] = 'pg';
    const fromMongo = unmarked(await Model.findById(current._id).lean());
    expect(await findCurrentDcrRegistration(ENTRY)).toEqual(fromMongo);
    expect(await findUsableDcrRegistration(ENTRY, 'client-a')).toEqual(fromMongo);
    expect(await findUsableDcrRegistration({ id: 'other', issuer: ENTRY.issuer }, 'client-old')).toBeNull();
    expect(await findDcrRegistrationSecretOwner(old._id)).toEqual({
      _id: old._id, refusedAt: new Date('2026-11-01T00:00:00Z'), clientSecretRef: old.clientSecretRef,
    });
    expect((await listCurrentDcrRegistrations()).map((doc) => doc.clientId)).toEqual(['client-a']);
    await expect(claimCurrentDcrRegistration(ENTRY, insert('client-z'))).rejects.toThrow(/until step 4/);
    expect(await Model.countDocuments({})).toBe(2);
  });
});
