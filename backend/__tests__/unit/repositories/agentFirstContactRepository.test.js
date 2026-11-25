/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for the first-contact marker. The repository's Postgres table
// is the in-memory adapter here; Mongo is real, so both claims run with their
// production atomicity.
const mockPg = { current: null, options: null };
jest.mock('../../../repositories/dualStore', () => {
  const actual = jest.requireActual('../../../repositories/dualStore');
  const forward = (method) => (...args) => mockPg.current[method](...args);
  return {
    ...actual,
    pgTableAdapter: (options) => {
      mockPg.options = options;
      return Object.fromEntries(['upsert', 'remove', 'replace', 'removeAt', 'get', 'scan'].map((m) => [m, forward(m)]));
    },
  };
});
const mongoose = require('mongoose');
const AgentFirstContact = require('../../../models/AgentFirstContact');
const {
  claimFirstContact, claimPodGreeting, firstContactStore,
} = require('../../../repositories/agentFirstContactRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_AGENT_FIRST_CONTACT';
const DAY = 24 * 60 * 60 * 1000;
const at = (day) => new Date(Date.UTC(2026, 10, day));

describe('first-contact repository (ADR-034 step 2)', () => {
  const pod = new mongoose.Types.ObjectId();
  let identity;
  const firstFields = (now = at(1)) => ({ firstPodId: pod, createdAt: now });
  // The service's window: a stamp older than 30 days can be claimed again.
  const greet = (now) => claimPodGreeting(identity, pod, now, new Date(now.getTime() - 30 * DAY));

  beforeAll(async () => {
    await setupMongoDb();
    await AgentFirstContact.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await AgentFirstContact.deleteMany({});
    identity = { userId: new mongoose.Types.ObjectId(), agentName: 'scout', instanceId: 'default' };
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = () => AgentFirstContact.findOne(identity).lean();
  const rowOf = async () => mockPg.current.rows.get(String((await raw())._id));
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;

  it('declares the table, its JSON column and the id the cursor uses', () => {
    firstContactStore();
    expect(mockPg.options).toMatchObject({
      table: 'agent_first_contacts',
      idColumn: 'id',
      columns: ['user_id', 'agent_name', 'instance_id', 'first_pod_id', 'greeted_at_by_pod', 'created_at'],
      jsonColumns: ['greeted_at_by_pod'],
    });
  });

  it('names the columns 0017 creates, and nothing else', () => {
    firstContactStore();
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const path = require('path');
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0017_agent_first_contacts.sql'), 'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|TIMESTAMPTZ|INTEGER|JSONB)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
  });

  describe('mongo (the default)', () => {
    it('keeps both claims, with no markers and no Postgres call', async () => {
      expect(await claimFirstContact(identity, firstFields())).toEqual({ inserted: true });
      expect(await claimFirstContact(identity, firstFields())).toEqual({ inserted: false });
      expect(await greet(at(2))).toBe(true);
      expect(await greet(at(3))).toBe(false);
      expect(await greet(at(40))).toBe(true);
      const doc = await raw();
      expect(doc.greetedAtByPod).toEqual({ [String(pod)]: at(40) });
      expect(doc.pgVersion).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('the first claim wins once, and its row is copied at version 1', async () => {
      expect(await claimFirstContact(identity, {
        ...firstFields(), greetedAtByPod: { [String(pod)]: at(1) },
      })).toEqual({ inserted: true });
      const doc = await raw();
      expect(doc).toMatchObject({ pgVersion: 1, agentName: 'scout', instanceId: 'default' });
      expect(doc.pgPending).toBeUndefined();
      // The model stamps createdAt only (updatedAt: false), and the stamp wins over
      // the caller's createdAt, as Mongoose's upsert does in mongo mode.
      expect(doc.updatedAt).toBeUndefined();
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.createdAt).not.toEqual(at(1));
      expect(await rowOf()).toEqual({
        row: {
          id: String(doc._id),
          user_id: String(identity.userId),
          agent_name: 'scout',
          instance_id: 'default',
          first_pod_id: String(pod),
          greeted_at_by_pod: { [String(pod)]: at(1) },
          // Mongoose's own timestamp, set on insert (the caller's createdAt has always lost to it).
          created_at: doc.createdAt,
        },
        version: 1,
      });
    });

    it('a concurrent second claim loses, with no extra version bump or copy', async () => {
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => claimFirstContact(identity, firstFields())
        .catch((error) => (error.code === 11000 ? 'lost-race' : Promise.reject(error)))));
      expect(outcomes.filter((o) => o.inserted === true)).toHaveLength(1);
      const losers = outcomes.filter((o) => o.inserted !== true);
      expect(losers.every((o) => o === 'lost-race' || o.inserted === false)).toBe(true);
      expect(await claimFirstContact(identity, firstFields(at(9)))).toEqual({ inserted: false });
      expect(await AgentFirstContact.countDocuments({})).toBe(1);
      expect((await raw()).pgVersion).toBe(1);
      expect((await rowOf()).version).toBe(1);
      expect(upserts()).toBe(1);
    });

    it('the greeting claim wins and updates the row; a second one inside the window loses', async () => {
      await claimFirstContact(identity, firstFields());
      const [first, second] = await Promise.all([greet(at(2)), greet(at(2))]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      let doc = await raw();
      expect(doc).toMatchObject({ pgVersion: 2, greetedAtByPod: { [String(pod)]: at(2) } });
      expect(doc.pgPending).toBeUndefined();
      expect((await rowOf())).toMatchObject({ row: { greeted_at_by_pod: { [String(pod)]: at(2) } }, version: 2 });

      const copies = upserts();
      expect(await greet(at(20))).toBe(false);
      expect((await raw()).pgVersion).toBe(2);
      expect(upserts()).toBe(copies);

      expect(await greet(at(40))).toBe(true);
      doc = await raw();
      expect(doc).toMatchObject({ pgVersion: 3, greetedAtByPod: { [String(pod)]: at(40) } });
      expect((await rowOf())).toMatchObject({ row: { greeted_at_by_pod: { [String(pod)]: at(40) } }, version: 3 });
    });

    it('a greeting claim on a marker written before dual is copied, and the backfill and verify agree', async () => {
      // A pre-dual document: no version, and (as some may) no greeting map.
      await AgentFirstContact.collection.insertOne({ ...identity, firstPodId: pod, createdAt: at(1) });
      const store = firstContactStore();
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 1, inserted: 1 });
      expect((await rowOf()).version).toBe(0);
      expect(await greet(at(2))).toBe(true);
      expect((await rowOf())).toMatchObject({ row: { greeted_at_by_pod: { [String(pod)]: at(2) } }, version: 1 });
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('a failed marker clear after a landed copy keeps the first claim won, for repair to finish', async () => {
      const clear = jest.spyOn(AgentFirstContact, 'updateOne')
        .mockImplementationOnce(() => Promise.reject(new Error('mongo blip')));
      expect(await claimFirstContact(identity, firstFields())).toEqual({ inserted: true });
      expect(clear).toHaveBeenCalledTimes(1);
      clear.mockRestore();
      expect((await raw()).pgPending).toBe(1);
      expect((await rowOf()).version).toBe(1);
      expect(await firstContactStore().repair()).toMatchObject({ failed: 0 });
      expect((await raw()).pgPending).toBeUndefined();
    });

    it('a failed marker clear after a landed copy keeps the greeting claim won, for repair to finish', async () => {
      await claimFirstContact(identity, firstFields());
      const clear = jest.spyOn(AgentFirstContact, 'updateOne')
        .mockImplementationOnce(() => Promise.reject(new Error('mongo blip')));
      expect(await greet(at(2))).toBe(true);
      expect(clear).toHaveBeenCalledTimes(1);
      clear.mockRestore();
      expect((await raw())).toMatchObject({ pgVersion: 2, pgPending: 2 });
      expect((await rowOf()).version).toBe(2);
      expect(await firstContactStore().repair()).toMatchObject({ failed: 0 });
      expect((await raw()).pgPending).toBeUndefined();
    });

    it('a failed copy leaves the claim won and the marker for the repair job', async () => {
      mockPg.current.failNext('upsert');
      expect(await claimFirstContact(identity, firstFields())).toEqual({ inserted: true });
      expect((await raw()).pgPending).toBe(1);
      expect(await firstContactStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect((await rowOf()).version).toBe(1);
    });
  });

  it('pg-read: the claims read nothing back, and a row read returns the Mongo shape', async () => {
    // The model has no read path; findById here is only the store's, as verify and pg mode use it.
    process.env[ENV] = 'pg-read';
    await claimFirstContact(identity, { ...firstFields(), greetedAtByPod: { [String(pod)]: at(1) } });
    const doc = await raw();
    expect(await firstContactStore().findById(doc._id)).toEqual({
      _id: doc._id,
      userId: identity.userId,
      agentName: 'scout',
      instanceId: 'default',
      firstPodId: pod,
      greetedAtByPod: { [String(pod)]: at(1) },
      createdAt: doc.createdAt,
    });
  });

  it('pg: both claims refuse until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    await expect(claimFirstContact(identity, firstFields())).rejects.toThrow(/not supported in pg mode until step 4/);
    await expect(greet(at(2))).rejects.toThrow(/not supported in pg mode until step 4/);
    expect(await AgentFirstContact.countDocuments({})).toBe(0);
    expect(mockPg.current.calls).toEqual([]);
  });
});
