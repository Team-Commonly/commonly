/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for waitlist requests. The repository's Postgres table is the
// in-memory adapter here; Mongo is real, so the populates, the case-insensitive
// search and the hydrated mongo-mode documents behave as in production.
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
const Model = require('../../../models/WaitlistRequest');
const InvitationCode = require('../../../models/InvitationCode');
const User = require('../../../models/User');
const {
  waitlistRequestStore, assertWaitlistWritable, populateWaitlistRefs, findPendingWaitlistRequest,
  createWaitlistRequest, listWaitlistRequests, setWaitlistRequestStatus, findWaitlistRequestForInvitation,
  markWaitlistRequestInvited, findWaitlistRequestPopulated,
} = require('../../../repositories/waitlistRequestRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_WAITLIST_REQUEST';
const MARKERS = ['pgVersion', 'pgPending', 'pgDeleted', '__v'];
const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });
const unmarked = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !MARKERS.includes(k)));
let seq = 0;
const form = (overrides = {}) => {
  seq += 1;
  return {
    email: `person-${seq}@test.invalid`, name: `Person ${seq}`, organization: 'Acme', useCase: 'agents', note: '',
    status: 'pending', ...overrides,
  };
};

describe('waitlist request repository (ADR-034 step 2)', () => {
  let admin;
  let code;

  beforeAll(async () => {
    await setupMongoDb();
    await Model.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Promise.all([Model.deleteMany({}), InvitationCode.deleteMany({}), User.deleteMany({})]);
    admin = await User.create({ username: 'wl-admin', email: 'wl-admin@test.invalid', password: 'x' });
    code = await InvitationCode.create({ code: 'CM-WAITLIST1', createdBy: admin._id });
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await waitlistRequestStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (id) => Model.findById(id).lean();
  const rowOf = (doc) => mockPg.current.rows.get(String(doc._id));
  const invited = (now = new Date()) => ({
    status: 'invited', invitationCode: code._id, invitedAt: now, invitationSentAt: now, invitedBy: String(admin._id),
  });
  const CLOSE = {
    status: 'closed', invitedAt: null, invitationSentAt: null, invitationCode: null, invitedBy: null,
  };
  // Stable views of what the routes read, without ids or dates.
  const viewRef = (ref) => (ref == null ? ref : Object.fromEntries(Object.entries(ref).filter(([k]) => k !== '_id')));
  const view = (doc) => (doc ? {
    email: doc.email, name: doc.name, status: doc.status, invitationCode: viewRef(doc.invitationCode),
    invitedBy: viewRef(doc.invitedBy), invitedAt: doc.invitedAt == null ? doc.invitedAt : 'set',
  } : null);

  /**
   * Every caller shape once, as the routes use them: the pending lookup and
   * create (and the duplicate lookup), the admin list with a case-insensitive
   * search and a status, an invitation (the access read, the mark, the
   * populated re-read), then a close that nulls the invitation fields, and an
   * absent id.
   */
  const sequence = async (tag) => {
    const out = [];
    const a = form({ email: `${tag}-alpha@test.invalid`, name: `${tag} Alpha`, organization: 'North' });
    const b = form({ email: `${tag}-beta@test.invalid`, name: `${tag} Beta`, organization: 'South' });
    out.push(await findPendingWaitlistRequest(a.email));
    const created = await createWaitlistRequest(a);
    out.push(String((await findPendingWaitlistRequest(a.email))._id) === String(created._id));
    // Newest first by createdAt alone (mongo mode has no tie-break), so apart.
    await tick();
    await createWaitlistRequest(b);
    const list = async (q, status) => {
      const { requests, total } = await listWaitlistRequests({
        q, status, skip: 0, limit: 20,
      });
      return { names: requests.map((r) => r.name), total };
    };
    out.push(await list(`${tag.toUpperCase()} AL`, 'all'));
    out.push(await list(`${tag}`, 'pending'));
    const forInvite = await findWaitlistRequestForInvitation(created._id);
    out.push(view(forInvite));
    await markWaitlistRequestInvited(forInvite, invited());
    out.push(view(await findWaitlistRequestPopulated(created._id)));
    out.push(await list(`${tag}`, 'invited'));
    out.push(await findPendingWaitlistRequest(a.email));
    out.push(view(await setWaitlistRequestStatus(created._id, CLOSE)));
    out.push(view(await findWaitlistRequestPopulated(created._id)));
    out.push(await setWaitlistRequestStatus(new Types.ObjectId(), { status: 'pending' }));
    out.push(await findWaitlistRequestForInvitation(new Types.ObjectId()));
    return { out, id: created._id };
  };
  const outcomes = (tag) => {
    const alpha = {
      email: `${tag}-alpha@test.invalid`, name: `${tag} Alpha`, invitationCode: null, invitedBy: null, invitedAt: null,
    };
    return [
      null,
      true,
      { names: [`${tag} Alpha`], total: 1 },
      { names: [`${tag} Beta`, `${tag} Alpha`], total: 2 },
      { ...alpha, status: 'pending' },
      {
        ...alpha, status: 'invited', invitationCode: { code: 'CM-WAITLIST1' },
        invitedBy: { username: 'wl-admin', email: 'wl-admin@test.invalid' }, invitedAt: 'set',
      },
      { names: [`${tag} Alpha`], total: 1 },
      null,
      { ...alpha, status: 'closed' },
      { ...alpha, status: 'closed' },
      null,
      null,
    ];
  };

  it('declares the table and the id column', () => {
    waitlistRequestStore();
    expect(mockPg.options).toMatchObject({ table: 'waitlist_requests', idColumn: 'id' });
  });

  it('names the columns 0028 creates, and nothing else; Mongo has no unique index or TTL to mirror', () => {
    waitlistRequestStore();
    const sql = fs.readFileSync(path.join(__dirname, '../../../config/migrations/0028_waitlist_requests.sql'), 'utf8');
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|TIMESTAMPTZ|INTEGER|BOOLEAN)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
    expect(sql).not.toMatch(/UNIQUE/);
    const indexes = Model.schema.indexes().filter(([keys]) => !('pgPending' in keys));
    expect(indexes).toEqual([
      [{ email: 1 }, expect.objectContaining({ background: true })],
      [{ status: 1 }, expect.objectContaining({ background: true })],
      [{ createdAt: -1 }, expect.anything()],
    ]);
    indexes.forEach(([, options]) => {
      expect(options.unique).toBeUndefined();
      expect(options.expireAfterSeconds).toBeUndefined();
    });
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 Mongoose calls, with no markers and no Postgres call', async () => {
      const findOne = jest.spyOn(Model, 'findOne');
      const create = jest.spyOn(Model, 'create');
      const find = jest.spyOn(Model, 'find');
      const count = jest.spyOn(Model, 'countDocuments');
      const findById = jest.spyOn(Model, 'findById');
      const findByIdAndUpdate = jest.spyOn(Model, 'findByIdAndUpdate');
      const save = jest.spyOn(Model.prototype, 'save');

      const { out, id } = await sequence('mtag');
      expect(out).toEqual(outcomes('mtag'));
      expect(findOne).toHaveBeenCalledWith({ email: 'mtag-alpha@test.invalid', status: 'pending' });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ email: 'mtag-alpha@test.invalid', status: 'pending' }));
      expect(find).toHaveBeenCalledWith({
        $or: [
          { email: { $regex: 'MTAG AL', $options: 'i' } },
          { name: { $regex: 'MTAG AL', $options: 'i' } },
          { organization: { $regex: 'MTAG AL', $options: 'i' } },
        ],
      });
      expect(count).toHaveBeenCalledWith(expect.objectContaining({ status: 'invited' }));
      expect(findById).toHaveBeenCalledWith(id);
      expect(findByIdAndUpdate).toHaveBeenCalledWith(id, { $set: CLOSE }, { new: true });
      expect(save).toHaveBeenCalled();
      expect((await raw(id)).pgVersion).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('hands back hydrated documents where the routes had them', async () => {
      const created = await createWaitlistRequest(form());
      expect(typeof created.save).toBe('function');
      expect(typeof (await findWaitlistRequestForInvitation(created._id)).save).toBe('function');
      expect(typeof (await findPendingWaitlistRequest(created.email)).save).toBe('function');
      expect(typeof (await setWaitlistRequestStatus(created._id, { status: 'closed' })).save).toBe('function');
    });
  });

  it("populate parity: the hand populate equals Mongoose's, for a found and a missing ref", async () => {
    const goneUser = new Types.ObjectId();
    const goneCode = new Types.ObjectId();
    const found = await Model.create({ ...form(), invitationCode: code._id, invitedBy: admin._id });
    const missing = await Model.create({ ...form(), invitationCode: goneCode, invitedBy: goneUser });
    const unset = await Model.create(form());
    // An old document with neither path at all.
    const bare = new Types.ObjectId();
    await Model.collection.insertOne({ _id: bare, email: 'bare@test.invalid', status: 'pending' });
    const ids = [found._id, missing._id, unset._id, bare];
    const mongoose = await Model.find({ _id: { $in: ids } })
      .populate('invitationCode', 'code')
      .populate('invitedBy', 'username email')
      .sort({ _id: 1 })
      .lean();
    const byHand = await populateWaitlistRefs(await Model.find({ _id: { $in: ids } }).sort({ _id: 1 }).lean());
    expect(byHand).toEqual(mongoose);
    expect(byHand[0].invitationCode).toEqual({ _id: code._id, code: 'CM-WAITLIST1' });
    expect(byHand[0].invitedBy).toEqual({ _id: admin._id, username: 'wl-admin', email: 'wl-admin@test.invalid' });
    expect(byHand[1]).toMatchObject({ invitationCode: null, invitedBy: null });
    expect(byHand[2]).toMatchObject({ invitationCode: null, invitedBy: null });
    expect('invitationCode' in byHand[3]).toBe(false);
    expect('invitedBy' in byHand[3]).toBe(false);
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('gives the same answers as mongo, and copies each change', async () => {
      delete process.env[ENV];
      expect((await sequence('mtag')).out).toEqual(outcomes('mtag'));
      process.env[ENV] = mode;
      const { out, id } = await sequence('dtag');
      expect(out).toEqual(outcomes('dtag'));
      const doc = await raw(id);
      // create, invite, close: three versions, none pending.
      expect(doc).toMatchObject({ pgVersion: 3, status: 'closed' });
      expect(doc.pgPending).toBeUndefined();
      expect(rowOf(doc)).toEqual({
        row: {
          id: String(id),
          email: 'dtag-alpha@test.invalid',
          name: 'dtag Alpha',
          organization: 'North',
          use_case: 'agents',
          note: '',
          status: 'closed',
          invitation_code: null,
          invited_at: null,
          invitation_sent_at: null,
          invited_by: null,
          created_at: doc.createdAt,
          updated_at: doc.updatedAt,
        },
        version: 3,
      });
      // The two mongo-mode documents have no rows; ours have, and match.
      expect(await waitlistRequestStore().verify()).toMatchObject({ missing: 2, differs: 0, extra: 0 });
    });

    it("the close's nulls land in both stores, over an invitation that set them", async () => {
      const created = await createWaitlistRequest(form());
      const now = new Date('2026-11-26T10:00:00Z');
      await markWaitlistRequestInvited(await findWaitlistRequestForInvitation(created._id), invited(now));
      expect(rowOf(created).row).toMatchObject({
        status: 'invited', invitation_code: String(code._id), invited_by: String(admin._id), invited_at: now,
        invitation_sent_at: now,
      });
      expect(await raw(created._id)).toMatchObject({ invitedBy: admin._id, invitationCode: code._id });
      await setWaitlistRequestStatus(created._id, CLOSE);
      expect(await raw(created._id)).toMatchObject({
        status: 'closed', invitationCode: null, invitedAt: null, invitationSentAt: null, invitedBy: null,
      });
      expect(rowOf(created)).toMatchObject({
        row: {
          status: 'closed', invitation_code: null, invited_at: null, invitation_sent_at: null, invited_by: null,
        },
        version: 3,
      });
    });

    it('the reads that decide a write stay on Mongo, so a lagging row never answers them', async () => {
      const created = await createWaitlistRequest(form());
      const stale = rowOf(created);
      await markWaitlistRequestInvited(await findWaitlistRequestForInvitation(created._id), invited());
      // Postgres one version behind (the invitation's copy has not landed),
      // and another request's row missing entirely.
      mockPg.current.rows.set(String(created._id), stale);
      const other = await createWaitlistRequest(form());
      mockPg.current.rows.delete(String(other._id));
      mockPg.current.calls.length = 0;
      expect(await findPendingWaitlistRequest(created.email)).toBeNull();
      expect(await findWaitlistRequestForInvitation(other._id)).toMatchObject({ email: other.email });
      expect(await findPendingWaitlistRequest(other.email)).toMatchObject({ email: other.email });
      expect((await listWaitlistRequests({
        q: '', status: 'invited', skip: 0, limit: 20,
      })).total).toBe(1);
      expect(mockPg.current.calls).toEqual([]);
    });

    it('reads the request in the lean shape, refs populated', async () => {
      const created = await createWaitlistRequest(form());
      await markWaitlistRequestInvited(await findWaitlistRequestForInvitation(created._id), invited());
      const lean = await Model.findById(created._id)
        .populate('invitationCode', 'code').populate('invitedBy', 'username email').lean();
      expect(await findWaitlistRequestPopulated(created._id)).toEqual(unmarked(lean));
      expect(await findWaitlistRequestForInvitation(created._id)).toEqual(unmarked(await raw(created._id)));
    });

    it('a failed copy is not a failed write, and repair finishes the row', async () => {
      const created = await createWaitlistRequest(form());
      mockPg.current.failNext('upsert');
      expect(await setWaitlistRequestStatus(created._id, CLOSE)).toMatchObject({ status: 'closed' });
      const doc = await raw(created._id);
      expect(doc).toMatchObject({ pgVersion: 2, pgPending: 2 });
      expect(rowOf(doc)).toMatchObject({ row: { status: 'pending' }, version: 1 });
      expect(await waitlistRequestStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect(rowOf(doc)).toMatchObject({ row: { status: 'closed' }, version: 2 });
    });

    it('an invitation for a request deleted meanwhile throws, as save() does', async () => {
      const created = await createWaitlistRequest(form());
      const found = await findWaitlistRequestForInvitation(created._id);
      await Model.deleteOne({ _id: created._id });
      await expect(markWaitlistRequestInvited(found, invited())).rejects.toThrow(/no longer exists/);
    });

    it('backfill copies requests written before dual, and a dual write lands above them', async () => {
      delete process.env[ENV];
      const created = await createWaitlistRequest(form());
      process.env[ENV] = mode;
      const store = waitlistRequestStore();
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 1, inserted: 1 });
      expect(rowOf(created)).toMatchObject({ row: { status: 'pending', email: created.email }, version: 0 });
      await setWaitlistRequestStatus(created._id, CLOSE);
      expect(rowOf(created)).toMatchObject({ row: { status: 'closed' }, version: 1 });
      expect(await store.verify()).toMatchObject({
        mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
      });
    });
  });

  it('pg: the pending lookup reads Postgres; every write and the list refuse until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    const id = new Types.ObjectId();
    const NOW = new Date('2026-11-26T10:00:00Z');
    mockPg.current.rows.set(String(id), {
      row: {
        id: String(id), email: 'pg@test.invalid', name: 'Pg', organization: '', use_case: '', note: '',
        status: 'pending', invitation_code: null, invited_at: null, invitation_sent_at: null, invited_by: null,
        created_at: NOW, updated_at: NOW,
      },
      version: 1,
    });
    const expected = {
      _id: id, email: 'pg@test.invalid', name: 'Pg', organization: '', useCase: '', note: '', status: 'pending',
      invitationCode: null, invitedAt: null, invitationSentAt: null, invitedBy: null, createdAt: NOW, updatedAt: NOW,
    };
    expect(await findPendingWaitlistRequest(' PG@test.invalid ')).toEqual(expected);
    expect(await findWaitlistRequestForInvitation(id)).toEqual(expected);
    mockPg.current.calls.length = 0;
    const refused = /not supported in pg mode until step 4/;
    expect(() => assertWaitlistWritable('sendInvitation')).toThrow(refused);
    await expect(createWaitlistRequest(form())).rejects.toThrow(refused);
    await expect(setWaitlistRequestStatus(id, CLOSE)).rejects.toThrow(refused);
    await expect(markWaitlistRequestInvited(expected, invited(NOW))).rejects.toThrow(refused);
    await expect(listWaitlistRequests({
      q: '', status: 'all', skip: 0, limit: 20,
    })).rejects.toThrow(refused);
    expect(mockPg.current.calls).toEqual([]);
    expect(mockPg.current.rows.get(String(id)).version).toBe(1);
    expect(await Model.countDocuments({})).toBe(0);
  });
});
