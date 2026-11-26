/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * The waitlist's routes against a real mongod: the public request
 * (authController.requestWaitlist) and the admin list, status change and
 * send-invitation (routes/admin/users.ts), every status and body pinned.
 *
 * ADR-034 step 2: this file runs as it is in every store mode. By default it
 * runs in mongo. With STORE_MODE_WAITLIST_REQUEST=dual or pg-read and the PG_*
 * settings of a throwaway Postgres that has run 0028, the same assertions hold
 * and each test also checks Postgres matches Mongo (verify) at its end. pg mode
 * is pinned at the end: every write route refuses before any write.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const ADMIN_ID = '6b07f5f77a1890a1ab6ae401';
jest.mock('../../repositories/recordChainRepository', () => ({ deleteOpeningsFor: jest.fn().mockResolvedValue(0) }));
jest.mock('../../services/adminUserMutationService', () => ({
  withAdminUserMutation: (_actor, operation) => operation(() => {}),
  AdminUserMutationError: class extends Error {},
}));
jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '6b07f5f77a1890a1ab6ae401', role: 'admin' };
  next();
});
jest.mock('../../middleware/adminAuth', () => (_req, _res, next) => next());
jest.mock('../../services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));

const ENV = 'STORE_MODE_WAITLIST_REQUEST';
const MODE = process.env[ENV] || 'mongo';
const { sendEmail } = require('../../services/emailService');
const User = require('../../models/User');
const InvitationCode = require('../../models/InvitationCode');
const Model = require('../../models/WaitlistRequest');
const { waitlistRequestStore } = require('../../repositories/waitlistRequestRepository');
const authController = require('../../controllers/authController');

const app = express();
app.use(express.json());
app.post('/auth/waitlist', authController.requestWaitlist);
app.use('/admin/users', require('../../routes/admin/users'));

const pgPool = () => require('../../config/db-pg').pool; // eslint-disable-line global-require
const pgRow = async (id) => (await pgPool().query('SELECT * FROM waitlist_requests WHERE id = $1', [String(id)])).rows[0];
const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });
const iso = (date) => new Date(date).toISOString();

describe(`waitlist routes (${MODE})`, () => {
  let admin;

  beforeAll(async () => {
    await setupMongoDb();
    await Promise.all([Model.init(), InvitationCode.init(), User.init()]);
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Promise.all([Model.deleteMany({}), InvitationCode.deleteMany({}), User.deleteMany({})]);
    if (MODE !== 'mongo') {
      await pgPool().query('TRUNCATE waitlist_requests');
      // Clears the store's 5-second flag cache on an empty collection.
      await waitlistRequestStore().repair();
    }
    admin = await User.create({
      _id: new mongoose.Types.ObjectId(ADMIN_ID), username: 'wl-admin', email: 'wl-admin@test.invalid', password: 'x',
    });
    sendEmail.mockClear();
    process.env.SMTP2GO_API_KEY = 'test-key';
    process.env.SMTP2GO_FROM_EMAIL = 'support@test.invalid';
    process.env.FRONTEND_URL = 'https://app.test.invalid';
  });
  afterEach(async () => {
    delete process.env.SMTP2GO_API_KEY;
    delete process.env.SMTP2GO_FROM_EMAIL;
    delete process.env.FRONTEND_URL;
    if (MODE !== 'mongo') {
      expect(await waitlistRequestStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    }
  });

  const ask = (body) => request(app).post('/auth/waitlist').send(body);
  const seed = async (body) => {
    const res = await ask(body);
    expect(res.status).toBe(201);
    await tick();
    return res.body.requestId;
  };

  it('a request is created once while pending; a registered email is refused', async () => {
    const first = await ask({
      email: ' Ada@Test.Invalid ', name: ' Ada ', organization: 'Analytical', useCase: 'engines', note: 'hi',
    });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      message: 'Waitlist request submitted. A global admin can review and send an invitation code by email.',
      requestId: expect.stringMatching(/^[0-9a-f]{24}$/),
    });
    const again = await ask({ email: 'ada@test.invalid' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ message: 'Your waitlist request is already pending review.', requestId: first.body.requestId });
    expect((await ask({ email: 'wl-admin@test.invalid' })).status).toBe(409);
    expect((await ask({ email: 'not-an-email' })).status).toBe(400);
    const doc = await Model.findById(first.body.requestId).lean();
    expect(doc).toMatchObject({
      email: 'ada@test.invalid', name: 'Ada', organization: 'Analytical', useCase: 'engines', note: 'hi',
      status: 'pending', invitationCode: null, invitedBy: null, invitedAt: null, invitationSentAt: null,
    });
    expect(await Model.countDocuments({})).toBe(1);
    if (MODE !== 'mongo') {
      expect(await pgRow(doc._id)).toMatchObject({
        email: 'ada@test.invalid', name: 'Ada', status: 'pending', invitation_code: null, pg_version: 1,
      });
    }
  });

  it('the admin list searches case-insensitively, filters, pages newest first and populates', async () => {
    const a = await seed({ email: 'alpha@test.invalid', name: 'Alpha One', organization: 'Northwind' });
    const b = await seed({ email: 'beta@test.invalid', name: 'Beta', organization: 'Southwind' });
    const c = await seed({ email: 'gamma@test.invalid', name: 'Gamma', organization: 'Eastwind' });
    const sent = await request(app).post(`/admin/users/waitlist/${a}/send-invitation`).send({ code: 'cm-alpha' });
    expect(sent.status).toBe(200);
    // An invited request whose code was later deleted: its ref populates as null.
    await request(app).post(`/admin/users/waitlist/${b}/send-invitation`).send({ code: 'CM-BETA' });
    await InvitationCode.deleteOne({ code: 'CM-BETA' });

    const all = await request(app).get('/admin/users/waitlist');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({
      total: 3, page: 1, limit: 20, totalPages: 1,
    });
    expect(all.body.requests.map((r) => r.id)).toEqual([c, b, a]);
    const docA = await Model.findById(a).lean();
    expect(all.body.requests[2]).toEqual({
      id: a,
      email: 'alpha@test.invalid',
      name: 'Alpha One',
      organization: 'Northwind',
      useCase: '',
      note: '',
      status: 'invited',
      createdAt: iso(docA.createdAt),
      updatedAt: iso(docA.updatedAt),
      invitedAt: iso(docA.invitedAt),
      invitationSentAt: iso(docA.invitationSentAt),
      invitationCode: { id: String(docA.invitationCode), code: 'CM-ALPHA' },
      invitedBy: { id: ADMIN_ID, username: 'wl-admin', email: 'wl-admin@test.invalid' },
    });
    expect(all.body.requests[1]).toMatchObject({ status: 'invited', invitationCode: null });
    expect(all.body.requests[0]).toMatchObject({ status: 'pending', invitationCode: null, invitedBy: null });

    const search = async (query) => (await request(app).get('/admin/users/waitlist').query(query)).body;
    expect((await search({ q: 'SOUTHWIND' })).requests.map((r) => r.id)).toEqual([b]);
    expect((await search({ q: 'ALPHA@' })).requests.map((r) => r.id)).toEqual([a]);
    expect((await search({ q: 'wind', status: 'invited' })).requests.map((r) => r.id)).toEqual([b, a]);
    expect((await search({ status: 'pending' })).total).toBe(1);
    // An unknown status filters nothing, as before.
    expect((await search({ status: 'bogus' })).total).toBe(3);
    // q goes into $regex unescaped (admin-only; unchanged by this move): '.' matches any character.
    expect((await search({ q: 'gamm.' })).requests.map((r) => r.id)).toEqual([c]);
    const page2 = await search({ limit: '2', page: '2' });
    expect(page2).toMatchObject({
      total: 3, page: 2, limit: 2, totalPages: 2,
    });
    expect(page2.requests.map((r) => r.id)).toEqual([a]);
  });

  it('a status change answers 400, 404 and 200, and a close nulls the invitation in both stores', async () => {
    const id = await seed({ email: 'close@test.invalid', name: 'Close' });
    expect((await request(app).patch(`/admin/users/waitlist/${id}`).send({ status: 'nope' })).status).toBe(400);
    const absent = await request(app).patch(`/admin/users/waitlist/${new mongoose.Types.ObjectId()}`)
      .send({ status: 'invited' });
    expect(absent.status).toBe(404);
    expect(absent.body).toEqual({ error: 'Waitlist request not found' });
    expect((await request(app).patch('/admin/users/waitlist/not-an-id').send({ status: 'invited' })).status).toBe(500);

    expect((await request(app).post(`/admin/users/waitlist/${id}/send-invitation`).send({})).status).toBe(200);
    const closed = await request(app).patch(`/admin/users/waitlist/${id}`).send({ status: 'CLOSED' });
    expect(closed.status).toBe(200);
    const doc = await Model.findById(id).lean();
    expect(closed.body).toEqual({
      message: 'Waitlist request updated',
      request: {
        id,
        email: 'close@test.invalid',
        name: 'Close',
        organization: '',
        useCase: '',
        note: '',
        status: 'closed',
        createdAt: iso(doc.createdAt),
        updatedAt: iso(doc.updatedAt),
        invitedAt: null,
        invitationSentAt: null,
        invitationCode: null,
        invitedBy: null,
      },
    });
    expect(doc).toMatchObject({
      status: 'closed', invitationCode: null, invitedBy: null, invitedAt: null, invitationSentAt: null,
    });
    if (MODE !== 'mongo') {
      expect(await pgRow(id)).toMatchObject({
        status: 'closed', invitation_code: null, invited_by: null, invited_at: null, invitation_sent_at: null,
        pg_version: 3,
      });
    }
    const reopened = await request(app).patch(`/admin/users/waitlist/${id}`).send({ status: 'pending' });
    expect(reopened.body.request).toMatchObject({ status: 'pending', invitationCode: null });
  });

  it('send-invitation answers 503 without SMTP, 404 when absent, and records the invitation', async () => {
    const id = await seed({ email: 'invite@test.invalid', name: 'Invitee' });
    delete process.env.SMTP2GO_API_KEY;
    expect((await request(app).post(`/admin/users/waitlist/${id}/send-invitation`).send({})).status).toBe(503);
    process.env.SMTP2GO_API_KEY = 'test-key';
    const absent = await request(app).post(`/admin/users/waitlist/${new mongoose.Types.ObjectId()}/send-invitation`)
      .send({});
    expect(absent.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();

    const res = await request(app).post(`/admin/users/waitlist/${id}/send-invitation`)
      .send({ code: 'cm-invite1', maxUses: 2 });
    expect(res.status).toBe(200);
    const doc = await Model.findById(id).lean();
    const invite = await InvitationCode.findOne({ code: 'CM-INVITE1' }).lean();
    expect(invite).toMatchObject({ note: 'waitlist:invite@test.invalid', maxUses: 2, createdBy: admin._id });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'invite@test.invalid' }));
    expect(doc).toMatchObject({
      status: 'invited', invitationCode: invite._id, invitedBy: admin._id,
    });
    expect(doc.invitedAt).toEqual(doc.invitationSentAt);
    expect(res.body).toEqual({
      message: 'Invitation email sent',
      invitation: expect.objectContaining({ id: String(invite._id), code: 'CM-INVITE1', maxUses: 2 }),
      request: {
        id,
        email: 'invite@test.invalid',
        name: 'Invitee',
        organization: '',
        useCase: '',
        note: '',
        status: 'invited',
        createdAt: iso(doc.createdAt),
        updatedAt: iso(doc.updatedAt),
        invitedAt: iso(doc.invitedAt),
        invitationSentAt: iso(doc.invitationSentAt),
        invitationCode: { id: String(invite._id), code: 'CM-INVITE1' },
        invitedBy: { id: ADMIN_ID, username: 'wl-admin', email: 'wl-admin@test.invalid' },
      },
    });
    if (MODE !== 'mongo') {
      expect(await pgRow(id)).toMatchObject({
        status: 'invited', invitation_code: String(invite._id), invited_by: ADMIN_ID, pg_version: 2,
      });
    }
    // The request is no longer pending, so the same person can ask again.
    expect((await ask({ email: 'invite@test.invalid' })).status).toBe(201);
  });

  // Only where Mongo is the store this file starts from: pg reads Postgres.
  (MODE === 'mongo' ? it : it.skip)('pg: every write route refuses before any write, and the list refuses', async () => {
    const id = await seed({ email: 'pg@test.invalid', name: 'Pg' });
    process.env[ENV] = 'pg';
    try {
      expect((await request(app).get('/admin/users/waitlist')).status).toBe(500);
      expect((await request(app).patch(`/admin/users/waitlist/${id}`).send({ status: 'closed' })).status).toBe(500);
      const sent = await request(app).post(`/admin/users/waitlist/${id}/send-invitation`).send({ code: 'CM-PG' });
      expect(sent.status).toBe(500);
    } finally {
      delete process.env[ENV];
    }
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await InvitationCode.countDocuments({})).toBe(0);
    expect(await Model.findById(id).lean()).toMatchObject({ status: 'pending', invitationCode: null });
  });
});
