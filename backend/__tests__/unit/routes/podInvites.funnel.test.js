const express = require('express');
const request = require('supertest');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  if (!req.get('x-user')) return res.sendStatus(401);
  req.userId = req.get('x-user');
  req.user = { id: req.userId, role: req.get('x-role') || 'user' };
  return next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => (
  req.user.role === 'admin' ? next() : res.sendStatus(403)
));
jest.mock('../../../services/agentIdentityService', () => ({ DM_POD_TYPES_GUARD: new Set(['agent-room', 'agent-dm']) }));
jest.mock('../../../services/outsiderGrantAgentJoinPolicy', () => ({ assertInstalledAgentMayJoinPod: jest.fn() }));
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const { PodInvite } = require('../../../models/PodInvite');
const inviteRoutes = require('../../../routes/podInvites');
const analyticsRoutes = require('../../../routes/admin/analytics');
let app;
let alice;
let bob;
let staff;
let pod;
beforeAll(async () => {
  await setupMongoDb();
  app = express(); app.use(express.json());
  app.use('/api', inviteRoutes);
  app.use('/api/admin/analytics', analyticsRoutes);
});
afterAll(closeMongoDb);
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Pod.deleteMany({}), PodInvite.deleteMany({})]);
  alice = await User.create({ username: 'alice-cohort', email: 'alice@outside-company.org', password: 'test-password-123',
    onboarding: { podOpenedAt: new Date('2026-10-20T12:00:00Z') } });
  bob = await User.create({ username: 'bob-cohort', email: 'bob@outside-company.org', password: 'test-password-123',
    onboarding: { podOpenedAt: new Date('2026-10-24T12:00:00Z') } });
  staff = await User.create({ username: 'staff-cohort', email: 'staff@outside-company.org', role: 'admin', password: 'test-password-123' });
  pod = await Pod.create({ name: 'Invite test', type: 'team', members: [alice._id], createdBy: alice._id });
});
const mint = (body = {}, user = alice) => request(app).post(`/api/pods/${pod.id}/invites`).set('x-user', user.id).send(body);
const redeem = (token, user) => request(app).post(`/api/invites/${token}/redeem`).set('x-user', user.id).send({});
const stats = () => request(app).get('/api/admin/analytics/invites?days=30').set('x-user', staff.id).set('x-role', 'admin');

test('mint binds the cohort to the authenticated inviter and normalizes the UI source', async () => {
  const response = await mint({ source: 'first-agent-post', createdBy: bob.id, inviterFirstSessionAt: '1900-01-01' });
  expect(response.status).toBe(201);
  const invite = await PodInvite.findOne({ token: response.body.token }).lean();
  expect(String(invite.createdBy)).toBe(alice.id);
  expect(invite.source).toBe('first-agent-post');
  const links = await request(app).get(`/api/pods/${pod.id}/invites`).set('x-user', alice.id).expect(200);
  expect(links.body).toEqual(expect.arrayContaining([expect.objectContaining({
    token: response.body.token, source: 'first-agent-post', createdBy: expect.objectContaining({ _id: alice.id }),
  })]));
  expect(invite.inviterFirstSessionAt.toISOString()).toBe('2026-10-20T12:00:00.000Z');
  const unknown = await mint({ source: 'not-a-placement' });
  expect((await PodInvite.findOne({ token: unknown.body.token })).source).toBe('pod-menu');
  expect((await mint({}, bob)).status).toBe(403);
});
test('one outside teammate converts once; self uses, repeats and staff do not inflate it', async () => {
  const response = await mint({ source: 'scout-first-session' });
  const token = response.body.token;
  await redeem(token, alice).expect(200);
  await redeem(token, staff).expect(200);
  expect((await PodInvite.findOne({ token })).firstTeammateJoinedAt).toBeUndefined();
  await redeem(token, bob).expect(200);
  const first = (await PodInvite.findOne({ token })).firstTeammateJoinedAt;
  expect(first).toBeInstanceOf(Date);
  await redeem(token, bob).expect(200);
  expect((await PodInvite.findOne({ token })).firstTeammateJoinedAt).toEqual(first);
  const report = await stats().expect(200);
  expect(report.body.cohorts).toEqual([{ firstSessionDay: '2026-10-20', created: 1, used: 1, inviters: 1, convertedInviters: 1 }]);
  expect(report.body.sources['scout-first-session']).toEqual({ created: 1, used: 1 });
  expect(JSON.stringify(report.body)).not.toContain(token);
  expect(JSON.stringify(report.body)).not.toContain(alice.id);
});
test('analytics excludes staff inviters and admits an explicit unobserved cohort', async () => {
  await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: staff._id } });
  await mint({}, staff).expect(201);
  await User.updateOne({ _id: alice._id }, { $unset: { 'onboarding.podOpenedAt': '' } });
  await mint({ source: 'solo-pod' }).expect(201);
  const report = await stats().expect(200);
  expect(report.body.cohorts).toEqual([{ firstSessionDay: null, created: 1, used: 0, inviters: 1, convertedInviters: 0 }]);
  expect(report.body.sources['pod-menu']).toBeUndefined();
  await request(app).get('/api/admin/analytics/invites').set('x-user', alice.id).expect(403);
  await request(app).get('/api/admin/analytics/invites').expect(401);
});

test('bot redemption does not count as a new outside teammate', async () => {
  const bot = await User.create({ username: 'bot-cohort', email: 'bot@outside-company.org', password: 'test-password-123', isBot: true });
  const response = await mint({ source: 'scout-first-session' });
  await redeem(response.body.token, bot).expect(200);
  expect((await PodInvite.findOne({ token: response.body.token })).firstTeammateJoinedAt).toBeUndefined();
  const report = await stats().expect(200);
  expect(report.body.sources['scout-first-session']).toEqual({ created: 1, used: 0 });
});
test('invites outside the creation window contribute to neither cohorts nor sources', async () => {
  await PodInvite.create({ token: 'f'.repeat(32), podId: pod.id, createdBy: alice.id,
    source: 'pod-menu', createdAt: new Date(Date.now() - 31 * 86400000),
    inviterFirstSessionAt: new Date('2026-09-01T12:00:00Z'), firstTeammateJoinedAt: new Date(),
  });
  await mint({ source: 'solo-pod' }).expect(201);
  const report = await stats().expect(200);
  expect(report.body.sources).toEqual({ 'solo-pod': { created: 1, used: 0 } });
  expect(report.body.cohorts).toEqual([{ firstSessionDay: '2026-10-20', created: 1, used: 0, inviters: 1, convertedInviters: 0 }]);
});
