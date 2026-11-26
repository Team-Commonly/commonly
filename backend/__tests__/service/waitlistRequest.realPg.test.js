/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for WaitlistRequest on real PostgreSQL: migration 0028 run
 * twice, then every caller shape in dual and pg-read through the real
 * pgTableAdapter SQL (create, the pending lookup, the admin list, an
 * invitation, a close whose nulls must land in the row), pg mode reading the
 * rows back in the lean shape, and verify finding both stores equal.
 */
const fs = require('fs');
const path = require('path');

const mockDb = { pool: null };
jest.mock('../../config/db-pg', () => ({
  pool: { query: (...args) => mockDb.pool.query(...args) },
}));

const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const Model = require('../../models/WaitlistRequest');
const InvitationCode = require('../../models/InvitationCode');
const User = require('../../models/User');
const {
  waitlistRequestStore, findPendingWaitlistRequest, createWaitlistRequest, listWaitlistRequests,
  setWaitlistRequestStatus, findWaitlistRequestForInvitation, markWaitlistRequestInvited,
  findWaitlistRequestPopulated,
} = require('../../repositories/waitlistRequestRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(path.join(__dirname, '../../config/migrations/0028_waitlist_requests.sql'), 'utf8');
const ENV = 'STORE_MODE_WAITLIST_REQUEST';
const MARKERS = ['__v', 'pgVersion', 'pgPending', 'pgDeleted'];
const unmarked = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !MARKERS.includes(k)));
const CLOSE = {
  status: 'closed', invitedAt: null, invitationSentAt: null, invitationCode: null, invitedBy: null,
};
const form = (tag) => ({
  email: `${tag}@test.invalid`, name: `Name ${tag}`, organization: `Org ${tag}`, useCase: 'agents', note: 'n',
  status: 'pending',
});

real('WaitlistRequest on real PostgreSQL (ADR-034 step 2)', () => {
  let database;
  let admin;
  let code;

  beforeAll(async () => {
    await setupMongoDb();
    await Model.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await Promise.all([Model.deleteMany({}), InvitationCode.deleteMany({}), User.deleteMany({})]);
    admin = await User.create({ username: 'rp-admin', email: 'rp-admin@test.invalid', password: 'x' });
    code = await InvitationCode.create({ code: 'CM-REALPG1', createdBy: admin._id });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // An empty collection's repair resets the store's flag cache.
    process.env[ENV] = 'dual';
    await waitlistRequestStore().repair();
    delete process.env[ENV];
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  const row = async (id) => (await database.pool.query(
    'SELECT * FROM waitlist_requests WHERE id = $1', [String(id)],
  )).rows[0];

  it('0028 is a no-op on a second run: every column but id and pg_version nullable, no unique index', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'waitlist_requests' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['created_at', 'email', 'id', 'invitation_code',
      'invitation_sent_at', 'invited_at', 'invited_by', 'name', 'note', 'organization', 'pg_version', 'status',
      'updated_at', 'use_case']);
    expect(rows.filter((r) => r.is_nullable === 'NO').map((r) => r.column_name)).toEqual(['id', 'pg_version']);
    const indexes = (await database.pool.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'waitlist_requests' ORDER BY indexname",
    )).rows;
    expect(indexes.map((i) => i.indexname)).toEqual(['waitlist_requests_created_at', 'waitlist_requests_email_status',
      'waitlist_requests_pkey']);
    expect(indexes.filter((i) => /UNIQUE/.test(i.indexdef)).map((i) => i.indexname)).toEqual(['waitlist_requests_pkey']);
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('every caller shape writes Mongo first and copies; the close lands its nulls in the row', async () => {
      expect(await findPendingWaitlistRequest('a@test.invalid')).toBeNull();
      const a = await createWaitlistRequest(form('a'));
      await createWaitlistRequest(form('b'));
      expect(String((await findPendingWaitlistRequest('A@test.invalid'))._id)).toBe(String(a._id));
      expect(await row(a._id)).toMatchObject({
        email: 'a@test.invalid', name: 'Name a', organization: 'Org a', use_case: 'agents', note: 'n',
        status: 'pending', invitation_code: null, invited_by: null, pg_version: 1,
      });

      const now = new Date('2026-11-26T12:00:00Z');
      await markWaitlistRequestInvited(await findWaitlistRequestForInvitation(a._id), {
        status: 'invited', invitationCode: code._id, invitedAt: now, invitationSentAt: now, invitedBy: String(admin._id),
      });
      expect(await row(a._id)).toMatchObject({
        status: 'invited', invitation_code: String(code._id), invited_by: String(admin._id), invited_at: now,
        invitation_sent_at: now, pg_version: 2,
      });
      const populated = await findWaitlistRequestPopulated(a._id);
      expect(populated.invitationCode).toEqual({ _id: code._id, code: 'CM-REALPG1' });
      expect(populated.invitedBy).toEqual({ _id: admin._id, username: 'rp-admin', email: 'rp-admin@test.invalid' });

      const { requests, total } = await listWaitlistRequests({
        q: 'ORG A', status: 'invited', skip: 0, limit: 20,
      });
      expect(total).toBe(1);
      expect(requests[0]).toMatchObject({ email: 'a@test.invalid', invitationCode: { code: 'CM-REALPG1' } });

      const closed = await setWaitlistRequestStatus(a._id, CLOSE);
      expect(closed).toMatchObject(CLOSE);
      expect(await Model.findById(a._id).lean()).toMatchObject(CLOSE);
      expect(await row(a._id)).toMatchObject({
        status: 'closed', invitation_code: null, invited_by: null, invited_at: null, invitation_sent_at: null,
        pg_version: 3,
      });
      expect(await waitlistRequestStore().verify()).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
    });

    it('a request read back from Postgres has the lean shape Mongo returns', async () => {
      const a = await createWaitlistRequest(form('c'));
      await setWaitlistRequestStatus(a._id, CLOSE);
      const mongoDoc = unmarked(await Model.findById(a._id).lean());
      process.env[ENV] = 'pg';
      expect(await waitlistRequestStore().findById(a._id)).toEqual(mongoDoc);
      expect(await findWaitlistRequestForInvitation(a._id)).toEqual(mongoDoc);
      expect(await findPendingWaitlistRequest('c@test.invalid')).toBeNull();
      expect(await findWaitlistRequestPopulated(a._id)).toEqual(mongoDoc);
    });
  });

  it('pg: the pending lookup reads Postgres; the writes refuse before any write', async () => {
    process.env[ENV] = 'dual';
    const a = await createWaitlistRequest(form('d'));
    process.env[ENV] = 'pg';
    expect(String((await findPendingWaitlistRequest('d@test.invalid'))._id)).toBe(String(a._id));
    const refused = /not supported in pg mode until step 4/;
    await expect(createWaitlistRequest(form('e'))).rejects.toThrow(refused);
    await expect(setWaitlistRequestStatus(a._id, CLOSE)).rejects.toThrow(refused);
    expect(await row(a._id)).toMatchObject({ status: 'pending', pg_version: 1 });
    expect((await database.pool.query('SELECT count(*)::int AS n FROM waitlist_requests')).rows[0].n).toBe(1);
    expect(await Model.countDocuments({})).toBe(1);
  });
});
