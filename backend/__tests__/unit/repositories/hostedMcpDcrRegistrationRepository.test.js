/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for the instance's hosted-MCP DCR clients. The repository's
// Postgres table is the in-memory adapter here; Mongo is real, so the unique
// current-client index and the claims keep their production atomicity.
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
const Model = require('../../../models/HostedMcpDcrRegistration');
const {
  dcrRegistrationStore, assertDcrRegistrationWritable, initDcrRegistrations, findCurrentDcrRegistration,
  findUsableDcrRegistration, findDcrRegistrationSecretOwner, listCurrentDcrRegistrations,
  claimCurrentDcrRegistration, retireDcrRegistrationById, retireCurrentDcrRegistration, refuseDcrRegistration,
  claimDcrAsk,
} = require('../../../repositories/hostedMcpDcrRegistrationRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_HOSTED_MCP_DCR_REGISTRATION';
const INTERVAL = 10 * 60 * 1000;
const CALLBACK = 'https://api.example.test/callback';
let entrySeq = 0;
const newEntry = () => { entrySeq += 1; return { id: `entry-${entrySeq}`, issuer: 'https://auth.example.test' }; };
// clientSecretRef is a ConnectorSecret id, never a secret; these stand in for them.
const ref = () => new Types.ObjectId().toHexString();
const insert = (clientId, overrides = {}) => ({
  _id: new Types.ObjectId(),
  clientId,
  redirectUri: CALLBACK,
  tokenEndpointAuthMethod: 'client_secret_basic',
  clientSecretRef: ref(),
  clientSecretExpiresAt: null,
  ...overrides,
});
const later = () => new Date(Date.now() + 2 * INTERVAL);

describe('hosted MCP DCR registration repository (ADR-034 step 2)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await Model.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Model.deleteMany({});
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await dcrRegistrationStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (id) => Model.findById(id).lean();
  const rowOf = (doc) => mockPg.current.rows.get(String(doc._id));
  const MARKERS = ['pgVersion', 'pgPending', 'pgDeleted'];
  const STORE_FIELDS = [...MARKERS, '__v', '_id', 'entryId', 'clientId', 'clientSecretRef', 'createdAt', 'updatedAt',
    'retiredAt', 'refusedAt', 'askedAt'];
  const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !STORE_FIELDS.includes(k)));
  const unmarked = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => ![...MARKERS, '__v'].includes(k)));

  /**
   * Every caller shape once, as the registry uses them: an absent current
   * client, a claim that wins and one that finds it, the row read, the ask
   * claim (taken once per interval), a retire that names another client, the
   * refusal (its pre-image once), the reads that must then refuse it, a claim
   * retired by id, a claim retired by entry, and the script's list.
   */
  const sequence = async (entry) => {
    const ids = [];
    const label = (doc) => (doc ? ids.indexOf(String(doc._id)) : null);
    const view = (doc) => (doc ? {
      at: label(doc), clientId: doc.clientId, current: doc.current, refused: Boolean(doc.refusedAt),
      asked: Boolean(doc.askedAt),
    } : null);
    const claim = async (clientId) => {
      const fields = insert(clientId);
      ids.push(String(fields._id));
      return claimCurrentDcrRegistration(entry, fields);
    };
    const now = later();
    const out = [];
    out.push(await findCurrentDcrRegistration(entry));
    out.push(view(await claim('client-a')));
    out.push(view(await claim('client-b')));
    out.push(view(await findUsableDcrRegistration(entry, 'client-a')));
    out.push(view(await claimDcrAsk(entry, 'client-a', new Date(), INTERVAL)));
    out.push(view(await claimDcrAsk(entry, 'client-a', now, INTERVAL)));
    out.push(view(await claimDcrAsk(entry, 'client-a', now, INTERVAL)));
    out.push(await retireCurrentDcrRegistration(entry, 'client-x', now));
    out.push(view(await refuseDcrRegistration(entry, 'client-a', now)));
    out.push(view(await refuseDcrRegistration(entry, 'client-a', now)));
    out.push(view(await findUsableDcrRegistration(entry, 'client-a')));
    out.push(view(await findCurrentDcrRegistration(entry)));
    const c = await claim('client-c');
    out.push(view(c));
    await retireDcrRegistrationById(c._id, now);
    out.push(view(await findCurrentDcrRegistration(entry)));
    out.push(view(await findUsableDcrRegistration(entry, 'client-c')));
    out.push(view(await claim('client-d')));
    out.push(await retireCurrentDcrRegistration(entry, undefined, now));
    out.push(await retireCurrentDcrRegistration(entry, undefined, now));
    out.push((await listCurrentDcrRegistrations()).length);
    return out;
  };
  const OUTCOMES = [
    null,
    { at: 0, clientId: 'client-a', current: true, refused: false, asked: false },
    { at: 0, clientId: 'client-a', current: true, refused: false, asked: false },
    { at: 0, clientId: 'client-a', current: true, refused: false, asked: false },
    null,
    { at: 0, clientId: 'client-a', current: true, refused: false, asked: true },
    null,
    false,
    { at: 0, clientId: 'client-a', current: true, refused: false, asked: true },
    null,
    null,
    null,
    { at: 2, clientId: 'client-c', current: true, refused: false, asked: false },
    null,
    { at: 2, clientId: 'client-c', current: false, refused: false, asked: false },
    { at: 3, clientId: 'client-d', current: true, refused: false, asked: false },
    true,
    false,
    0,
  ];

  it('declares the table and the id column', () => {
    dcrRegistrationStore();
    expect(mockPg.options).toMatchObject({ table: 'hosted_mcp_dcr_registrations', idColumn: 'id' });
  });

  it("names the columns 0027 creates, and nothing else, with Mongo's two unique indexes and no TTL", () => {
    dcrRegistrationStore();
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0027_hosted_mcp_dcr_registrations.sql'), 'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|TIMESTAMPTZ|INTEGER|BOOLEAN)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS hosted_mcp_dcr_registrations_current\s+ON hosted_mcp_dcr_registrations \(entry_id, issuer\) WHERE current;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS hosted_mcp_dcr_registrations_client\s+ON hosted_mcp_dcr_registrations \(entry_id, issuer, client_id\);/);
    const indexes = Model.schema.indexes().filter(([keys]) => !('pgPending' in keys));
    expect(indexes).toEqual([
      [{ entryId: 1, issuer: 1 }, expect.objectContaining({ unique: true, partialFilterExpression: { current: true } })],
      [{ entryId: 1, issuer: 1, clientId: 1 }, expect.objectContaining({ unique: true })],
    ]);
    indexes.forEach(([, options]) => expect(options.expireAfterSeconds).toBeUndefined());
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 Mongoose calls, with no markers and no Postgres call', async () => {
      const entry = newEntry();
      const findOne = jest.spyOn(Model, 'findOne');
      const findOneAndUpdate = jest.spyOn(Model, 'findOneAndUpdate');
      const updateOne = jest.spyOn(Model, 'updateOne');
      const init = jest.spyOn(Model, 'init');

      await initDcrRegistrations();
      expect(init).toHaveBeenCalledTimes(1);
      expect(await sequence(entry)).toEqual(OUTCOMES);
      const current = { entryId: entry.id, issuer: entry.issuer, current: true };
      expect(findOne).toHaveBeenNthCalledWith(1, current);
      expect(findOne).toHaveBeenCalledWith({
        entryId: entry.id, issuer: entry.issuer, clientId: 'client-a', refusedAt: null,
      });
      expect(findOneAndUpdate).toHaveBeenNthCalledWith(1, current, {
        $setOnInsert: expect.objectContaining({ clientId: 'client-a', entryId: entry.id, issuer: entry.issuer, current: true }),
      }, { upsert: true, new: true, setDefaultsOnInsert: true });
      expect(findOneAndUpdate).toHaveBeenCalledWith({
        ...current,
        clientId: 'client-a',
        refusedAt: null,
        createdAt: { $lte: expect.any(Date) },
        $or: [{ askedAt: null }, { askedAt: { $lte: expect.any(Date) } }],
      }, { $set: { askedAt: expect.any(Date) } }, { new: true });
      expect(findOneAndUpdate).toHaveBeenCalledWith(
        { entryId: entry.id, issuer: entry.issuer, clientId: 'client-a', refusedAt: null },
        { $set: { refusedAt: expect.any(Date), retiredAt: expect.any(Date), current: false } },
      );
      expect(updateOne).toHaveBeenCalledWith(
        { _id: expect.any(Types.ObjectId), current: true },
        { $set: { current: false, retiredAt: expect.any(Date) } },
      );
      expect(updateOne).toHaveBeenCalledWith(
        { ...current, clientId: 'client-x' }, { $set: { current: false, retiredAt: expect.any(Date) } },
      );
      expect((await Model.findOne({ clientId: 'client-a' }).lean()).pgVersion).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('the sweep read selects refusedAt and clientSecretRef only, as select() did', async () => {
      const fields = insert('client-a');
      await claimCurrentDcrRegistration(newEntry(), fields);
      const found = await findDcrRegistrationSecretOwner(fields._id);
      expect(Object.keys(found).sort()).toEqual(['_id', 'clientSecretRef', 'refusedAt']);
      expect(found.clientSecretRef).toBe(fields.clientSecretRef);
      expect(await findDcrRegistrationSecretOwner(new Types.ObjectId())).toBeNull();
    });

    it('lists current clients by entryId, as the script read them', async () => {
      const [b, a] = [{ id: 'b-entry', issuer: 'https://b' }, { id: 'a-entry', issuer: 'https://a' }];
      await claimCurrentDcrRegistration(b, insert('client-b'));
      await claimCurrentDcrRegistration(a, insert('client-a'));
      const retired = insert('client-r');
      await claimCurrentDcrRegistration({ id: 'c-entry', issuer: 'https://c' }, retired);
      await retireDcrRegistrationById(retired._id, new Date());
      expect((await listCurrentDcrRegistrations()).map((doc) => doc.entryId)).toEqual(['a-entry', 'b-entry']);
    });
  });

  describe.each(['mongo', 'dual', 'pg-read'])('%s: every claim has exactly one winner', (mode) => {
    beforeEach(() => { if (mode === 'mongo') delete process.env[ENV]; else process.env[ENV] = mode; });

    it('racing first registrations: one current client, every resolved call names it', async () => {
      const entry = newEntry();
      const tries = Array.from({ length: 6 }, (_, i) => insert(`client-${i}`));
      const settled = await Promise.allSettled(tries.map((fields) => claimCurrentDcrRegistration(entry, fields)));
      // mongo mode's server does not retry an upsert on a partial unique index,
      // so a loser there may throw 11000 (the registry then reads the winner);
      // the helper retries it onto the winner. Either way one client is current.
      settled.filter((s) => s.status === 'rejected').forEach((s) => expect(s.reason.code).toBe(11000));
      const winners = new Set(settled.filter((s) => s.status === 'fulfilled').map((s) => String(s.value._id)));
      if (mode !== 'mongo') expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
      expect(winners.size).toBe(1);
      const docs = await Model.find({ entryId: entry.id }).lean();
      expect(docs).toHaveLength(1);
      expect(String(docs[0]._id)).toBe([...winners][0]);
      expect(tries.map((t) => String(t._id))).toContain(String(docs[0]._id));
      if (mode !== 'mongo') expect(rowOf(docs[0])).toMatchObject({ row: { current: true }, version: 1 });
    });

    it('racing refusals: exactly one gets the pre-image (and deletes its secret)', async () => {
      const entry = newEntry();
      const fields = insert('client-a');
      await claimCurrentDcrRegistration(entry, fields);
      const results = await Promise.all(Array.from({ length: 5 }, () => refuseDcrRegistration(entry, 'client-a', new Date())));
      const got = results.filter(Boolean);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ clientSecretRef: fields.clientSecretRef, current: true, refusedAt: null });
      expect(await raw(fields._id)).toMatchObject({ current: false, refusedAt: expect.any(Date) });
    });

    it('racing asks: exactly one claim per interval, never on a young, refused or retired client', async () => {
      const entry = newEntry();
      const fields = insert('client-a');
      await claimCurrentDcrRegistration(entry, fields);
      expect(await claimDcrAsk(entry, 'client-a', new Date(), INTERVAL)).toBeNull();
      const now = later();
      const results = await Promise.all(Array.from({ length: 5 }, () => claimDcrAsk(entry, 'client-a', now, INTERVAL)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean).askedAt).toEqual(now);
      expect(await claimDcrAsk(entry, 'client-a', new Date(now.getTime() + 1000), INTERVAL)).toBeNull();
      const next = new Date(now.getTime() + INTERVAL);
      expect(await claimDcrAsk(entry, 'client-a', next, INTERVAL)).toMatchObject({ askedAt: next });

      expect(await retireCurrentDcrRegistration(entry, 'client-a', next)).toBe(true);
      expect(await claimDcrAsk(entry, 'client-a', new Date(next.getTime() + 2 * INTERVAL), INTERVAL)).toBeNull();
      const refusedEntry = newEntry();
      await claimCurrentDcrRegistration(refusedEntry, insert('client-r'));
      await Model.updateOne({ clientId: 'client-r' }, { $set: { refusedAt: new Date() } });
      expect(await claimDcrAsk(refusedEntry, 'client-r', later(), INTERVAL)).toBeNull();
    });

    it('a retire by id leaves a client that is no longer current alone, and a retire names the client', async () => {
      const entry = newEntry();
      const first = insert('client-a');
      await claimCurrentDcrRegistration(entry, first);
      expect(await retireCurrentDcrRegistration(entry, 'client-b', new Date())).toBe(false);
      await retireDcrRegistrationById(first._id, new Date('2026-11-25T10:00:00Z'));
      const second = insert('client-b');
      await claimCurrentDcrRegistration(entry, second);
      await retireDcrRegistrationById(first._id, new Date('2026-11-25T11:00:00Z'));
      expect((await raw(first._id)).retiredAt).toEqual(new Date('2026-11-25T10:00:00Z'));
      expect(await raw(second._id)).toMatchObject({ current: true, retiredAt: null });
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('gives the same answers and documents as mongo, and copies each change', async () => {
      const mongoEntry = newEntry();
      const entry = newEntry();
      delete process.env[ENV];
      expect(await sequence(mongoEntry)).toEqual(OUTCOMES);
      process.env[ENV] = mode;
      expect(await sequence(entry)).toEqual(OUTCOMES);

      const byClient = async (e, clientId) => Model.findOne({ entryId: e.id, clientId }).lean();
      for (const clientId of ['client-a', 'client-c', 'client-d']) {
        // eslint-disable-next-line no-await-in-loop
        const [doc, mongoDoc] = [await byClient(entry, clientId), await byClient(mongoEntry, clientId)];
        expect(payload(doc)).toEqual(payload(mongoDoc));
        expect(Object.keys(doc).filter((k) => !MARKERS.includes(k)).sort()).toEqual(Object.keys(mongoDoc).sort());
        expect(doc.pgPending).toBeUndefined();
        expect(rowOf(doc).version).toBe(doc.pgVersion);
      }
      const a = await byClient(entry, 'client-a');
      // claim, ask, refuse: three versions.
      expect(a.pgVersion).toBe(3);
      expect(rowOf(a)).toEqual({
        row: {
          id: String(a._id),
          entry_id: entry.id,
          issuer: entry.issuer,
          client_id: 'client-a',
          redirect_uri: CALLBACK,
          token_endpoint_auth_method: 'client_secret_basic',
          client_secret_ref: a.clientSecretRef,
          client_secret_expires_at: null,
          current: false,
          retired_at: a.retiredAt,
          refused_at: a.refusedAt,
          asked_at: a.askedAt,
          created_at: a.createdAt,
          updated_at: a.updatedAt,
        },
        version: 3,
      });
      // The mongo-mode documents have no rows; ours have, and match.
      expect(await dcrRegistrationStore().verify()).toMatchObject({ missing: 3, differs: 0, extra: 0 });
    });

    it('the security reads stay on Mongo, so a row that lags a refusal or a retire never admits the client', async () => {
      const entry = newEntry();
      const fields = insert('client-a');
      await claimCurrentDcrRegistration(entry, fields);
      const before = rowOf(await raw(fields._id));
      await refuseDcrRegistration(entry, 'client-a', new Date());
      // Postgres one version behind: the refusal's copy has not landed there.
      mockPg.current.rows.set(String(fields._id), before);
      mockPg.current.calls.length = 0;
      expect(await findCurrentDcrRegistration(entry)).toBeNull();
      expect(await findUsableDcrRegistration(entry, 'client-a')).toBeNull();
      expect(await findDcrRegistrationSecretOwner(fields._id)).toMatchObject({ refusedAt: expect.any(Date) });
      expect(await listCurrentDcrRegistrations()).toEqual([]);
      expect(mockPg.current.calls).toEqual([]);
    });

    it('reads the whole registration in the lean shape, from Mongo', async () => {
      const entry = newEntry();
      const fields = insert('client-a', { clientSecretExpiresAt: new Date('2027-01-01T00:00:00Z') });
      await claimCurrentDcrRegistration(entry, fields);
      const fromMongo = unmarked(await raw(fields._id));
      expect(await findCurrentDcrRegistration(entry)).toEqual(fromMongo);
      expect(await findUsableDcrRegistration(entry, 'client-a')).toEqual(fromMongo);
      expect(await findDcrRegistrationSecretOwner(fields._id)).toEqual({
        _id: fields._id, refusedAt: null, clientSecretRef: fields.clientSecretRef,
      });
    });

    it('a failed copy is not a failed write: the refusal resolves, and repair finishes the row', async () => {
      const entry = newEntry();
      const fields = insert('client-a');
      await claimCurrentDcrRegistration(entry, fields);
      mockPg.current.failNext('upsert');
      expect(await refuseDcrRegistration(entry, 'client-a', new Date())).toMatchObject({ refusedAt: null });
      const doc = await raw(fields._id);
      expect(doc).toMatchObject({ pgVersion: 2, pgPending: 2 });
      expect(rowOf(doc)).toMatchObject({ row: { refused_at: null, current: true }, version: 1 });
      expect(await dcrRegistrationStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect((await raw(fields._id)).pgPending).toBeUndefined();
      expect(rowOf(doc)).toMatchObject({ row: { refused_at: doc.refusedAt, current: false }, version: 2 });
    });

    it('backfill copies registrations written before dual, and a dual write lands above them', async () => {
      const entry = newEntry();
      const fields = insert('client-a');
      delete process.env[ENV];
      await claimCurrentDcrRegistration(entry, fields);
      process.env[ENV] = mode;
      const store = dcrRegistrationStore();
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 1, inserted: 1 });
      expect(rowOf(fields)).toMatchObject({
        row: { client_id: 'client-a', client_secret_ref: fields.clientSecretRef, current: true }, version: 0,
      });
      expect(await store.verify()).toMatchObject({
        mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
      });
      expect(await retireCurrentDcrRegistration(entry, 'client-a', new Date())).toBe(true);
      expect(rowOf(fields)).toMatchObject({ row: { current: false }, version: 1 });
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });
  });

  it('pg: reads Postgres, and the writes refuse until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    const entry = newEntry();
    const id = new Types.ObjectId();
    const secretRef = ref();
    const NOW = new Date('2026-11-25T10:00:00Z');
    mockPg.current.rows.set(String(id), {
      row: {
        id: String(id), entry_id: entry.id, issuer: entry.issuer, client_id: 'client-a', redirect_uri: CALLBACK,
        token_endpoint_auth_method: 'client_secret_basic', client_secret_ref: secretRef,
        client_secret_expires_at: null, current: true, retired_at: null, refused_at: null, asked_at: null,
        created_at: NOW, updated_at: NOW,
      },
      version: 2,
    });
    const expected = {
      _id: id, entryId: entry.id, issuer: entry.issuer, clientId: 'client-a', redirectUri: CALLBACK,
      tokenEndpointAuthMethod: 'client_secret_basic', clientSecretRef: secretRef, clientSecretExpiresAt: null,
      current: true, retiredAt: null, refusedAt: null, askedAt: null, createdAt: NOW, updatedAt: NOW,
    };
    expect(await findCurrentDcrRegistration(entry)).toEqual(expected);
    expect(await findUsableDcrRegistration(entry, 'client-a')).toEqual(expected);
    expect(await findDcrRegistrationSecretOwner(id)).toEqual({ _id: id, refusedAt: null, clientSecretRef: secretRef });
    expect(await listCurrentDcrRegistrations()).toEqual([expected]);
    mockPg.current.calls.length = 0;
    const init = jest.spyOn(Model, 'init');
    await initDcrRegistrations();
    expect(init).not.toHaveBeenCalled();
    const refused = /not supported in pg mode until step 4/;
    expect(() => assertDcrRegistrationWritable('ensureDcrClient')).toThrow(refused);
    await expect(claimCurrentDcrRegistration(entry, insert('client-b'))).rejects.toThrow(refused);
    await expect(retireDcrRegistrationById(id, NOW)).rejects.toThrow(refused);
    await expect(retireCurrentDcrRegistration(entry, 'client-a', NOW)).rejects.toThrow(refused);
    await expect(refuseDcrRegistration(entry, 'client-a', NOW)).rejects.toThrow(refused);
    await expect(claimDcrAsk(entry, 'client-a', later(), INTERVAL)).rejects.toThrow(refused);
    expect(mockPg.current.calls).toEqual([]);
    expect(await Model.countDocuments({})).toBe(0);
  });
});
