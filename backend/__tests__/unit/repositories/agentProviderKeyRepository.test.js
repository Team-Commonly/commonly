/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for an agent's own provider-key binding. The repository's
// Postgres table is the in-memory adapter here; Mongo is real, so the
// generation lock and the $inc upsert keep their production atomicity.
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
const AgentProviderKey = require('../../../models/AgentProviderKey');
const {
  providerKeyStore, findProviderKey, findProviderKeyForLaunch, findProviderKeyBySecretRef, clearProviderKey,
  bumpProviderKeyGeneration, commitProviderKey, markProviderKeyUsed,
} = require('../../../repositories/agentProviderKeyRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_AGENT_PROVIDER_KEY';
const NOW = new Date('2026-11-25T10:00:00Z');
const minutes = (m) => new Date(NOW.getTime() + m * 60000);
const DEST = { providerId: 'test-provider', baseURL: 'https://api.example.com/v1' };
// secretRef is a ConnectorSecret id, never key material; these stand in for them.
const ref = () => new Types.ObjectId().toHexString();
const newOwner = () => ({ agentUserId: new Types.ObjectId(), ownerUserId: String(new Types.ObjectId()) });
const commit = (secretRef, setBy, at = NOW) => ({
  secretRef, providerId: DEST.providerId, baseURL: DEST.baseURL, setAt: at, setBy, lastUsedAt: null,
});

describe('agent provider key repository (ADR-034 step 2)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await AgentProviderKey.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await AgentProviderKey.deleteMany({});
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await providerKeyStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (owner) => AgentProviderKey.findOne({ agentUserId: owner.agentUserId }).lean();
  const rowOf = (doc) => mockPg.current.rows.get(String(doc._id));
  const MARKERS = ['pgVersion', 'pgPending', 'pgDeleted'];
  const STORE_FIELDS = [...MARKERS, '__v', '_id', 'agentUserId', 'ownerUserId', 'setBy', 'createdAt', 'updatedAt'];
  const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !STORE_FIELDS.includes(k)));
  const unmarked = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => ![...MARKERS, '__v'].includes(k)));
  const view = (doc) => (doc ? { generation: doc.generation, secretRef: doc.secretRef } : null);

  /**
   * Every caller shape once, in the service's order: a read of an absent
   * binding, a remove of it (no write), a set (bump then commit), a stale
   * commit (loses), a launch read and its stamp, a stale stamp (loses), a
   * second set, the remove (its pre-image names the second secret), a stamp
   * of the removed generation (loses), and the sweep's lookups.
   */
  const sequence = async (owner, refs) => {
    const out = [];
    out.push(await findProviderKey(owner));
    out.push(await clearProviderKey(owner));
    const first = await bumpProviderKeyGeneration(owner, DEST);
    out.push(view(first));
    out.push(view(await commitProviderKey(owner, first.generation, commit(refs[0], owner.ownerUserId))));
    out.push(await commitProviderKey(owner, first.generation - 1, commit(refs[1], owner.ownerUserId)));
    const read = await findProviderKey(owner);
    out.push(view(read));
    out.push(await markProviderKeyUsed(read, minutes(1)));
    out.push(await markProviderKeyUsed({ ...read, generation: read.generation - 1 }, minutes(2)));
    const second = await bumpProviderKeyGeneration(owner, DEST);
    out.push(view(second));
    const set = await commitProviderKey(owner, second.generation, commit(refs[1], owner.ownerUserId, minutes(3)));
    out.push(view(set));
    out.push(view(await clearProviderKey(owner)));
    out.push(await markProviderKeyUsed(set, minutes(4)));
    out.push(await findProviderKeyBySecretRef(refs[1]));
    out.push(view(await findProviderKey(owner)));
    return out;
  };
  const outcomes = (refs) => [null, null, { generation: 1, secretRef: null }, { generation: 1, secretRef: refs[0] },
    null, { generation: 1, secretRef: refs[0] }, true, false, { generation: 2, secretRef: refs[0] },
    { generation: 2, secretRef: refs[1] }, { generation: 2, secretRef: refs[1] }, false, null,
    { generation: 3, secretRef: null }];

  it('declares the table, the id and the filter columns', () => {
    providerKeyStore();
    expect(mockPg.options).toMatchObject({ table: 'agent_provider_keys', idColumn: 'id' });
  });

  it('names the columns 0026 creates, and nothing else, and keeps agentUserId unique as Mongo does', () => {
    providerKeyStore();
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0026_agent_provider_keys.sql'), 'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|TIMESTAMPTZ|INTEGER)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS agent_provider_keys_agent_user_id\s+ON agent_provider_keys \(agent_user_id\)/,
    );
    expect(AgentProviderKey.schema.indexes())
      .toEqual(expect.arrayContaining([[{ agentUserId: 1 }, expect.objectContaining({ unique: true })]]));
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 Mongoose calls, with no markers and no Postgres call', async () => {
      const owner = newOwner();
      const refs = [ref(), ref()];
      const findOne = jest.spyOn(AgentProviderKey, 'findOne');
      const findOneAndUpdate = jest.spyOn(AgentProviderKey, 'findOneAndUpdate');
      const updateOne = jest.spyOn(AgentProviderKey, 'updateOne');

      expect(await sequence(owner, refs)).toEqual(outcomes(refs));
      const filter = { agentUserId: owner.agentUserId, ownerUserId: owner.ownerUserId };
      expect(findOne).toHaveBeenNthCalledWith(1, filter);
      expect(findOne).toHaveBeenCalledWith({ secretRef: refs[1] });
      expect(findOneAndUpdate).toHaveBeenNthCalledWith(1, filter, {
        $inc: { generation: 1 }, $set: { secretRef: null, setAt: null, setBy: null, lastUsedAt: null },
      }, { new: false });
      expect(findOneAndUpdate).toHaveBeenNthCalledWith(2, filter, {
        $inc: { generation: 1 }, $setOnInsert: DEST,
      }, { upsert: true, new: true, setDefaultsOnInsert: true });
      expect(findOneAndUpdate).toHaveBeenNthCalledWith(3, { ...filter, generation: 1 }, {
        $set: commit(refs[0], owner.ownerUserId),
      }, { new: true });
      expect(updateOne).toHaveBeenNthCalledWith(1, {
        _id: expect.any(Types.ObjectId), secretRef: refs[0], generation: 1,
      }, { $set: { lastUsedAt: minutes(1) } });
      expect((await raw(owner)).pgVersion).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('the sweep lookup selects only secretRef, as select("secretRef") did', async () => {
      const owner = newOwner();
      const secretRef = ref();
      const { generation } = await bumpProviderKeyGeneration(owner, DEST);
      await commitProviderKey(owner, generation, commit(secretRef, owner.ownerUserId));
      const found = await findProviderKeyBySecretRef(secretRef);
      expect(Object.keys(found).sort()).toEqual(['_id', 'secretRef']);
      expect(found.secretRef).toBe(secretRef);
      expect(await findProviderKeyBySecretRef(ref())).toBeNull();
    });
  });

  describe.each(['mongo', 'dual', 'pg-read'])('%s: the generation lock', (mode) => {
    beforeEach(() => { if (mode === 'mongo') delete process.env[ENV]; else process.env[ENV] = mode; });

    it('a commit at a generation a later set or remove moved past loses, and writes nothing', async () => {
      const owner = newOwner();
      const older = await bumpProviderKeyGeneration(owner, DEST);
      const newer = await bumpProviderKeyGeneration(owner, DEST);
      expect([older.generation, newer.generation]).toEqual([1, 2]);
      expect(await commitProviderKey(owner, older.generation, commit(ref(), owner.ownerUserId))).toBeNull();
      const kept = ref();
      expect(view(await commitProviderKey(owner, newer.generation, commit(kept, owner.ownerUserId))))
        .toEqual({ generation: 2, secretRef: kept });

      // A remove between a set's two steps: the set's commit loses.
      const late = await bumpProviderKeyGeneration(owner, DEST);
      expect(view(await clearProviderKey(owner))).toEqual({ generation: 3, secretRef: kept });
      expect(await commitProviderKey(owner, late.generation, commit(ref(), owner.ownerUserId))).toBeNull();
      expect(await raw(owner)).toMatchObject({ generation: 4, secretRef: null, setAt: null, setBy: null });
      if (mode !== 'mongo') {
        expect(rowOf(await raw(owner)).row).toMatchObject({ generation: 4, secret_ref: null, set_by: null });
      }
    });

    it('a stamp of a stale read loses: a newer set or a remove since the read refuses it', async () => {
      const owner = newOwner();
      const { generation } = await bumpProviderKeyGeneration(owner, DEST);
      await commitProviderKey(owner, generation, commit(ref(), owner.ownerUserId));
      const read = await findProviderKey(owner);
      const next = await bumpProviderKeyGeneration(owner, DEST);
      await commitProviderKey(owner, next.generation, commit(ref(), owner.ownerUserId));
      expect(await markProviderKeyUsed(read, NOW)).toBe(false);
      expect((await raw(owner)).lastUsedAt).toBeNull();
      expect(await markProviderKeyUsed(await findProviderKey(owner), NOW)).toBe(true);
      expect((await raw(owner)).lastUsedAt).toEqual(NOW);
    });

    it('racing first sets lose no increment: the generation counts every call that resolved', async () => {
      const owner = newOwner();
      const settled = await Promise.allSettled(Array.from({ length: 5 }, () => bumpProviderKeyGeneration(owner, DEST)));
      const done = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value.generation);
      // mongo mode's server does not retry an upsert whose filter is more than
      // the unique key, so a loser there may throw 11000 (the caller's 500);
      // the helper retries it onto the winner. Either way nothing is lost.
      settled.filter((s) => s.status === 'rejected').forEach((s) => expect(s.reason.code).toBe(11000));
      if (mode !== 'mongo') expect(done).toHaveLength(5);
      expect([...done].sort()).toEqual(Array.from({ length: done.length }, (_, i) => i + 1));
      expect((await raw(owner)).generation).toBe(done.length);
      expect(await AgentProviderKey.countDocuments({ agentUserId: owner.agentUserId })).toBe(1);
      if (mode !== 'mongo') {
        const doc = await raw(owner);
        expect(rowOf(doc)).toMatchObject({ row: { generation: done.length }, version: doc.pgVersion });
      }
    });

    it("another owner's set on the agent's binding fails on the unique key and writes nothing", async () => {
      const owner = newOwner();
      await bumpProviderKeyGeneration(owner, DEST);
      const before = await raw(owner);
      await expect(bumpProviderKeyGeneration({ ...owner, ownerUserId: String(new Types.ObjectId()) }, DEST))
        .rejects.toMatchObject({ code: 11000 });
      expect(await AgentProviderKey.countDocuments({})).toBe(1);
      expect(unmarked(await raw(owner))).toEqual(unmarked(before));
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('gives the same answers and documents as mongo, and copies each change', async () => {
      const mongoOwner = newOwner();
      const owner = newOwner();
      const refs = [ref(), ref()];
      delete process.env[ENV];
      expect(await sequence(mongoOwner, refs)).toEqual(outcomes(refs));
      process.env[ENV] = mode;
      expect(await sequence(owner, refs)).toEqual(outcomes(refs));

      const [doc, mongoDoc] = [await raw(owner), await raw(mongoOwner)];
      expect(payload(doc)).toEqual(payload(mongoDoc));
      expect(Object.keys(doc).filter((k) => !MARKERS.includes(k)).sort()).toEqual(Object.keys(mongoDoc).sort());
      expect(doc.pgPending).toBeUndefined();
      // bump, commit, stamp, bump, commit, remove: six versions.
      expect(doc.pgVersion).toBe(6);
      expect(rowOf(doc)).toEqual({
        row: {
          id: String(doc._id),
          agent_user_id: String(owner.agentUserId),
          owner_user_id: owner.ownerUserId,
          provider_id: DEST.providerId,
          base_url: DEST.baseURL,
          generation: 3,
          secret_ref: null,
          set_at: null,
          set_by: null,
          last_used_at: null,
          created_at: doc.createdAt,
          updated_at: doc.updatedAt,
        },
        version: 6,
      });
      // The mongo-mode document has no row; ours has, and matches.
      expect(await providerKeyStore().verify()).toMatchObject({ missing: 1, differs: 0, extra: 0 });
    });

    it('the remove returns the pre-image naming the removed secret, and copies the cleared binding', async () => {
      const owner = newOwner();
      const secretRef = ref();
      const { generation } = await bumpProviderKeyGeneration(owner, DEST);
      await commitProviderKey(owner, generation, commit(secretRef, owner.ownerUserId));
      const before = await raw(owner);
      const removed = await clearProviderKey(owner);
      expect(removed).toEqual(unmarked(before));
      expect(removed.setBy).toBeInstanceOf(Types.ObjectId);
      const after = await raw(owner);
      expect(after).toMatchObject({ generation: 2, secretRef: null, setAt: null, setBy: null, lastUsedAt: null });
      expect(after.pgVersion).toBe(before.pgVersion + 1);
      expect(rowOf(after)).toMatchObject({ row: { generation: 2, secret_ref: null, set_at: null }, version: 3 });
      // No binding: no write and no copy.
      mockPg.current.calls.length = 0;
      expect(await clearProviderKey(newOwner())).toBeNull();
      expect(mockPg.current.calls).toEqual([]);
      expect(await AgentProviderKey.countDocuments({})).toBe(1);
    });

    it('reads the whole binding in the lean shape, ObjectIds included, from the store the mode reads', async () => {
      const owner = newOwner();
      const secretRef = ref();
      const { generation } = await bumpProviderKeyGeneration(owner, DEST);
      await commitProviderKey(owner, generation, commit(secretRef, owner.ownerUserId));
      await markProviderKeyUsed(await findProviderKey(owner), minutes(1));
      const fromMongo = unmarked(await raw(owner));
      mockPg.current.calls.length = 0;

      const read = await findProviderKey(owner);
      expect(read).toEqual(fromMongo);
      expect(read.agentUserId).toBeInstanceOf(Types.ObjectId);
      expect(read.setBy).toBeInstanceOf(Types.ObjectId);
      expect(mockPg.current.calls.includes('findWhere')).toBe(mode === 'pg-read');
      expect(await findProviderKey(newOwner())).toBeNull();
    });

    it('the sweep lookup reads Mongo, so a Postgres row that lags a set never reads as unowned', async () => {
      const owner = newOwner();
      const secretRef = ref();
      const { generation } = await bumpProviderKeyGeneration(owner, DEST);
      await commitProviderKey(owner, generation, commit(secretRef, owner.ownerUserId));
      const doc = await raw(owner);
      // Postgres one version behind: the commit's copy has not landed there.
      mockPg.current.rows.set(String(doc._id), { ...rowOf(doc), row: { ...rowOf(doc).row, secret_ref: null } });
      mockPg.current.calls.length = 0;
      const found = await findProviderKeyBySecretRef(secretRef);
      expect(found).toEqual({ _id: doc._id, secretRef });
      expect(mockPg.current.calls).toEqual([]);
    });

    it('the launch read is Mongo\'s, so a Postgres row that lags a set, a replace or a remove never decides a launch', async () => {
      const owner = newOwner();
      const first = ref();
      const second = ref();
      const lagTo = (doc, row) => mockPg.current.rows.set(String(doc._id), { ...rowOf(doc), row: { ...rowOf(doc).row, ...row } });
      // A set whose copy has not landed: Postgres still has no key, unflagged.
      let { generation } = await bumpProviderKeyGeneration(owner, DEST);
      await commitProviderKey(owner, generation, commit(first, owner.ownerUserId));
      let doc = await raw(owner);
      lagTo(doc, { secret_ref: null });
      mockPg.current.calls.length = 0;
      expect(view(await findProviderKeyForLaunch(owner))).toEqual({ generation: 1, secretRef: first });
      expect(mockPg.current.calls).toEqual([]);
      // In pg-read the plain read answers from that row, which is why launch does not use it.
      if (mode === 'pg-read') expect((await findProviderKey(owner)).secretRef).toBeNull();
      mockPg.current.calls.length = 0;
      // A replace whose copy has not landed: Postgres still names the old secret.
      ({ generation } = await bumpProviderKeyGeneration(owner, DEST));
      await commitProviderKey(owner, generation, commit(second, owner.ownerUserId));
      doc = await raw(owner);
      lagTo(doc, { secret_ref: first, generation: 1 });
      const replaced = await findProviderKeyForLaunch(owner);
      expect(view(replaced)).toEqual({ generation: 2, secretRef: second });
      expect(String(replaced._id)).toBe(String(doc._id));
      // A remove whose copy has not landed: Postgres still names the second secret.
      await clearProviderKey(owner);
      doc = await raw(owner);
      lagTo(doc, { secret_ref: second, generation: 2 });
      expect(view(await findProviderKeyForLaunch(owner))).toEqual({ generation: 3, secretRef: null });
      expect(await findProviderKeyForLaunch(newOwner())).toBeNull();
      expect(mockPg.current.calls.filter((call) => call === 'get' || call === 'findWhere')).toEqual([]);
    });

    it('a failed copy is not a failed write: the set resolves, and repair finishes the row', async () => {
      const owner = newOwner();
      const secretRef = ref();
      const { generation } = await bumpProviderKeyGeneration(owner, DEST);
      mockPg.current.failNext('upsert');
      expect(view(await commitProviderKey(owner, generation, commit(secretRef, owner.ownerUserId))))
        .toEqual({ generation: 1, secretRef });
      const doc = await raw(owner);
      expect(doc.pgVersion).toBe(2);
      expect(doc.pgPending).toBeTruthy();
      expect(rowOf(doc)).toMatchObject({ row: { secret_ref: null }, version: 1 });
      // While flagged, pg-read reads Mongo, so the read shows the set.
      expect((await findProviderKey(owner)).secretRef).toBe(secretRef);
      expect(await providerKeyStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect((await raw(owner)).pgPending).toBeUndefined();
      expect(rowOf(doc)).toMatchObject({ row: { secret_ref: secretRef }, version: 2 });
    });

    it('backfill copies bindings written before dual, and a dual write lands above them', async () => {
      const owner = newOwner();
      const secretRef = ref();
      delete process.env[ENV];
      const { generation } = await bumpProviderKeyGeneration(owner, DEST);
      await commitProviderKey(owner, generation, commit(secretRef, owner.ownerUserId));
      process.env[ENV] = mode;
      const store = providerKeyStore();
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 1, inserted: 1 });
      const doc = await raw(owner);
      expect(rowOf(doc)).toMatchObject({
        row: { generation: 1, secret_ref: secretRef, set_by: owner.ownerUserId }, version: 0,
      });
      expect(await store.verify()).toMatchObject({
        mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
      });
      expect(await markProviderKeyUsed(await findProviderKey(owner), NOW)).toBe(true);
      expect(rowOf(doc)).toMatchObject({ row: { last_used_at: NOW }, version: 1 });
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });
  });

  it('pg: reads Postgres, and the writes refuse until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    const owner = newOwner();
    const id = new Types.ObjectId();
    const secretRef = ref();
    mockPg.current.rows.set(String(id), {
      row: {
        id: String(id), agent_user_id: String(owner.agentUserId), owner_user_id: owner.ownerUserId,
        provider_id: DEST.providerId, base_url: DEST.baseURL, generation: 2, secret_ref: secretRef,
        set_at: NOW, set_by: owner.ownerUserId, last_used_at: null, created_at: NOW, updated_at: NOW,
      },
      version: 3,
    });
    expect(await findProviderKey(owner)).toEqual({
      _id: id, agentUserId: owner.agentUserId, ownerUserId: new Types.ObjectId(owner.ownerUserId), ...DEST,
      generation: 2, secretRef, setAt: NOW, setBy: new Types.ObjectId(owner.ownerUserId), lastUsedAt: null,
      createdAt: NOW, updatedAt: NOW,
    });
    expect(await findProviderKeyBySecretRef(secretRef)).toEqual({ _id: id, secretRef });
    mockPg.current.calls.length = 0;
    const refused = /not supported in pg mode until step 4/;
    await expect(bumpProviderKeyGeneration(owner, DEST)).rejects.toThrow(refused);
    await expect(commitProviderKey(owner, 2, commit(ref(), owner.ownerUserId))).rejects.toThrow(refused);
    await expect(clearProviderKey(owner)).rejects.toThrow(refused);
    await expect(markProviderKeyUsed({ _id: id, secretRef, generation: 2 }, NOW)).rejects.toThrow(refused);
    expect(mockPg.current.calls).toEqual([]);
    expect(await AgentProviderKey.countDocuments({})).toBe(0);
  });
});
