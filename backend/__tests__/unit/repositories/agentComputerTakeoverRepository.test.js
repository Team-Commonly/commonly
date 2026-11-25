/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for agent computer takeovers. The repository's Postgres table
// is the in-memory adapter here; Mongo is real, so the owner-keyed upserts and
// their duplicate keys behave as in production.
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
const { AgentComputerTakeover } = require('../../../models/AgentComputerTakeover');
const {
  bindTarget, computerTakeoverStore, isTakeoverActive, listBindings, setTakeover,
} = require('../../../repositories/agentComputerTakeoverRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_AGENT_COMPUTER_TAKEOVER';

describe('agent computer takeover repository (ADR-034 step 2)', () => {
  let owner;
  let other;
  let install;

  beforeAll(async () => {
    await setupMongoDb();
    await AgentComputerTakeover.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    owner = String(new Types.ObjectId());
    other = String(new Types.ObjectId());
    install = String(new Types.ObjectId());
    await AgentComputerTakeover.deleteMany({});
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await computerTakeoverStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (id = install) => AgentComputerTakeover.findById(id).lean();
  const rowOf = (id = install) => mockPg.current.rows.get(String(id));
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;
  const STORE_FIELDS = ['_id', 'ownerId', 'pgVersion', 'pgPending', 'pgDeleted', '__v', 'createdAt', 'updatedAt'];
  const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !STORE_FIELDS.includes(key)));

  it('declares the table and the id', () => {
    computerTakeoverStore();
    expect(mockPg.options).toMatchObject({ table: 'agent_computer_takeovers', idColumn: 'id' });
  });

  it('names the columns 0021 creates, and nothing else, with owner_id indexed', () => {
    computerTakeoverStore();
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0021_agent_computer_takeovers.sql'), 'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|INTEGER|BOOLEAN|TIMESTAMPTZ)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS \w+\s+ON agent_computer_takeovers \(owner_id\)/);
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 Mongoose calls, with no markers and no Postgres call', async () => {
      // Mongoose adds to the objects it was handed, so each call's arguments
      // are recorded as they were passed.
      const passed = (method) => {
        const calls = [];
        const original = AgentComputerTakeover[method];
        jest.spyOn(AgentComputerTakeover, method).mockImplementation(function record(...args) {
          calls.push(JSON.parse(JSON.stringify(args)));
          return original.apply(this, args);
        });
        return calls;
      };
      const exists = passed('exists');
      const updateOne = passed('updateOne');
      const find = passed('find');

      expect(await isTakeoverActive(owner, install)).toBe(false);
      await setTakeover(owner, install, true);
      expect(await isTakeoverActive(owner, install)).toBe(true);
      await bindTarget(owner, install, 'target-1');
      expect(await listBindings(owner)).toEqual([{ installationId: install, targetId: 'target-1' }]);

      expect(exists).toEqual([
        [{ _id: install, ownerId: owner, active: true }],
        [{ _id: install, ownerId: owner, active: true }],
      ]);
      expect(updateOne).toEqual([
        [{ _id: install, ownerId: owner }, { $set: { active: true } }, { upsert: true }],
        [{ _id: install, ownerId: owner }, { $set: { targetId: 'target-1' }, $setOnInsert: { active: false } },
          { upsert: true }],
      ]);
      expect(find).toEqual([[{ ownerId: owner, targetId: { $exists: true } }]]);

      const doc = await raw();
      expect(doc.pgVersion).toBeUndefined();
      expect(doc.pgPending).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it("another owner's set on the installation throws a duplicate key, as before", async () => {
      await setTakeover(owner, install, true);
      await expect(setTakeover(other, install, false)).rejects.toMatchObject({ code: 11000 });
      expect(await raw()).toMatchObject({ ownerId: new Types.ObjectId(owner), active: true });
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('gives the same answers and document as mongo, and copies each change once', async () => {
      const mongoInstall = String(new Types.ObjectId());
      const steps = async (id) => {
        const seen = [await isTakeoverActive(owner, id)];
        await setTakeover(owner, id, true);
        seen.push(await isTakeoverActive(owner, id));
        await bindTarget(owner, id, 'target-1');
        await setTakeover(owner, id, false);
        seen.push(await isTakeoverActive(owner, id));
        return seen;
      };
      delete process.env[ENV];
      const mongoSeen = await steps(mongoInstall);
      process.env[ENV] = mode;
      const seen = await steps(install);
      expect(seen).toEqual([false, true, false]);
      expect(seen).toEqual(mongoSeen);
      // dual reads Mongo, which holds the mongo-mode document too; pg-read
      // reads Postgres, which holds only the copied one.
      const bindings = await listBindings(owner);
      const copied = { installationId: install, targetId: 'target-1' };
      if (mode === 'dual') {
        expect(bindings).toHaveLength(2);
        expect(bindings).toContainEqual(copied);
        expect(bindings).toContainEqual({ installationId: mongoInstall, targetId: 'target-1' });
      } else {
        expect(bindings).toEqual([copied]);
      }

      const doc = await raw();
      expect(payload(doc)).toEqual(payload(await raw(mongoInstall)));
      expect(doc.ownerId).toEqual(new Types.ObjectId(owner));
      // Insert, bind, unset: three versions, three copies.
      expect(doc.pgVersion).toBe(3);
      expect(doc.pgPending).toBeUndefined();
      expect(upserts()).toBe(3);
      expect(rowOf()).toEqual({
        row: {
          id: install,
          owner_id: owner,
          active: false,
          target_id: 'target-1',
          created_at: doc.createdAt,
          updated_at: doc.updatedAt,
        },
        version: 3,
      });
      expect(await computerTakeoverStore().verify()).toMatchObject({ missing: 1, differs: 0, extra: 0 });
    });

    it('a first bind starts inactive; a later set keeps the target', async () => {
      await bindTarget(owner, install, 'target-1');
      expect(await raw()).toMatchObject({ active: false, targetId: 'target-1', pgVersion: 1 });
      expect(await isTakeoverActive(owner, install)).toBe(false);
      await setTakeover(owner, install, true);
      await bindTarget(owner, install, 'target-2');
      expect(await raw()).toMatchObject({ active: true, targetId: 'target-2', pgVersion: 3 });
      expect(rowOf()).toMatchObject({ row: { active: true, target_id: 'target-2' }, version: 3 });
      expect(await computerTakeoverStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    describe('ownership', () => {
      beforeEach(async () => {
        await setTakeover(owner, install, true);
        await bindTarget(owner, install, 'target-1');
        mockPg.current.calls.length = 0;
      });

      it("another owner's set and bind throw a duplicate key and change neither store", async () => {
        const doc = await raw();
        const row = rowOf();
        await expect(setTakeover(other, install, false)).rejects.toMatchObject({ code: 11000 });
        await expect(bindTarget(other, install, 'evil-target')).rejects.toMatchObject({ code: 11000 });
        expect(await raw()).toEqual(doc);
        expect(rowOf()).toEqual(row);
        expect(upserts()).toBe(0);
        expect(await AgentComputerTakeover.countDocuments({})).toBe(1);
        expect(await computerTakeoverStore().verify()).toMatchObject({
          mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
        });
      });

      it("another owner never reads the owner's takeover as active", async () => {
        expect(await isTakeoverActive(owner, install)).toBe(true);
        expect(await isTakeoverActive(other, install)).toBe(false);
      });

      it("listBindings never returns another owner's rows", async () => {
        const otherInstall = String(new Types.ObjectId());
        await bindTarget(other, otherInstall, 'target-other');
        // An owner with a takeover but no target lists nothing for it.
        const bare = String(new Types.ObjectId());
        await setTakeover(other, bare, true);
        expect(await listBindings(other)).toEqual([{ installationId: otherInstall, targetId: 'target-other' }]);
        expect(await listBindings(owner)).toEqual([{ installationId: install, targetId: 'target-1' }]);
        expect(await listBindings(String(new Types.ObjectId()))).toEqual([]);
      });
    });

    it('concurrent first sets: one document, and the last writer\'s value in Mongo and the row', async () => {
      const store = computerTakeoverStore();
      const realUpdate = store.updateWhere;
      const realInsert = store.insertIfAbsent;
      // Both calls miss on their first update, so both go to insert.
      let misses = 0;
      let bothMissed;
      const missed = new Promise((resolve) => { bothMissed = resolve; });
      jest.spyOn(store, 'updateWhere').mockImplementation(async (...args) => {
        const matched = await realUpdate(...args);
        if (!matched && misses < 2) {
          misses += 1;
          if (misses === 2) bothMissed();
          await missed;
        }
        return matched;
      });
      // The true call inserts first; the false call's insert finds it, so the
      // false call updates last.
      let firstInserted;
      const inserted = new Promise((resolve) => { firstInserted = resolve; });
      const outcomes = [];
      jest.spyOn(store, 'insertIfAbsent').mockImplementation(async (filter, fields) => {
        if (fields.active === false) await inserted;
        const result = await realInsert(filter, fields);
        outcomes.push([fields.active, result.inserted]);
        if (fields.active === true) firstInserted();
        return result;
      });

      await Promise.all([setTakeover(owner, install, true), setTakeover(owner, install, false)]);
      expect(outcomes).toEqual([[true, true], [false, false]]);
      expect(await AgentComputerTakeover.countDocuments({})).toBe(1);
      expect(await raw()).toMatchObject({ active: false, pgVersion: 2 });
      expect(rowOf()).toMatchObject({ row: { active: false, owner_id: owner }, version: 2 });
      expect(await store.verify()).toMatchObject({
        mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
      });
    });

    it('a burst of first sets leaves one document whose row matches it', async () => {
      await Promise.all(Array.from({ length: 10 }, (_, i) => setTakeover(owner, install, i % 2 === 0)));
      expect(await AgentComputerTakeover.countDocuments({})).toBe(1);
      const doc = await raw();
      expect(doc.pgVersion).toBe(10);
      expect(rowOf()).toMatchObject({ row: { active: doc.active }, version: 10 });
      expect(await computerTakeoverStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('a failed copy leaves the change in Mongo and the marker for repair', async () => {
      await setTakeover(owner, install, true);
      mockPg.current.failNext('upsert');
      await setTakeover(owner, install, false);
      expect(await raw()).toMatchObject({ active: false, pgVersion: 2, pgPending: 2 });
      expect(rowOf()).toMatchObject({ row: { active: true }, version: 1 });
      expect(await computerTakeoverStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect((await raw()).pgPending).toBeUndefined();
      expect(rowOf()).toMatchObject({ row: { active: false }, version: 2 });
      expect(await computerTakeoverStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('backfill copies takeovers written before dual, and verify agrees', async () => {
      const bound = String(new Types.ObjectId());
      delete process.env[ENV];
      await setTakeover(owner, install, true);
      await bindTarget(other, bound, 'target-1');
      process.env[ENV] = mode;
      const store = computerTakeoverStore();
      expect(await store.verify()).toMatchObject({ mongo: 2, pg: 0, missing: 2 });
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
      expect(rowOf()).toMatchObject({ row: { active: true, target_id: null }, version: 0 });
      expect(rowOf(bound)).toMatchObject({
        row: { active: false, target_id: 'target-1', owner_id: other }, version: 0,
      });
      expect(await store.verify()).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
      // A dual write on a backfilled takeover lands at the next version.
      await setTakeover(owner, install, false);
      expect(rowOf()).toMatchObject({ row: { active: false }, version: 1 });
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });
  });

  describe('pg-read reads', () => {
    beforeEach(() => { process.env[ENV] = 'pg-read'; });

    it('come from Postgres, in the Mongo shape', async () => {
      await setTakeover(owner, install, false);
      await bindTarget(owner, install, 'target-1');
      // Mark the row so a read from it is visible.
      rowOf().row.active = true;
      rowOf().row.target_id = 'target-pg';
      mockPg.current.calls.length = 0;
      expect(await isTakeoverActive(owner, install)).toBe(true);
      expect(await isTakeoverActive(other, install)).toBe(false);
      expect(await listBindings(owner)).toEqual([{ installationId: install, targetId: 'target-pg' }]);
      expect(await listBindings(other)).toEqual([]);
      expect(mockPg.current.calls).toEqual(['findWhere', 'findWhere', 'findWhere', 'findWhere']);
    });

    it('fall back to Mongo while a document is flagged', async () => {
      await setTakeover(owner, install, false);
      mockPg.current.failNext('upsert');
      await setTakeover(owner, install, true);
      // Postgres still holds the first write; Mongo has the second.
      expect(rowOf().row.active).toBe(false);
      mockPg.current.calls.length = 0;
      expect(await isTakeoverActive(owner, install)).toBe(true);
      expect(mockPg.current.calls).not.toContain('findWhere');

      await computerTakeoverStore().repair();
      mockPg.current.calls.length = 0;
      expect(await isTakeoverActive(owner, install)).toBe(true);
      expect(mockPg.current.calls).toEqual(['findWhere']);
    });
  });

  it('pg: writes refuse until step 4, before any write; reads come from Postgres', async () => {
    process.env[ENV] = 'pg';
    await expect(setTakeover(owner, install, true)).rejects.toThrow(/not supported in pg mode until step 4/);
    await expect(bindTarget(owner, install, 't')).rejects.toThrow(/not supported in pg mode until step 4/);
    expect(await AgentComputerTakeover.countDocuments({})).toBe(0);
    expect(mockPg.current.calls).toEqual([]);

    mockPg.current.rows.set(install, {
      row: {
        id: install, owner_id: owner, active: true, target_id: 'target-1', created_at: null, updated_at: null,
      },
      version: 1,
    });
    expect(await isTakeoverActive(owner, install)).toBe(true);
    expect(await isTakeoverActive(other, install)).toBe(false);
    expect(await listBindings(owner)).toEqual([{ installationId: install, targetId: 'target-1' }]);
    expect(mockPg.current.calls).toEqual(['findWhere', 'findWhere', 'findWhere']);
  });
});
