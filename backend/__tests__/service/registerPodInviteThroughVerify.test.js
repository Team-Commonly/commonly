// F577: on a team-gated instance the follow-up login after sign-up fails until
// the mailbox is verified, so the browser tab that held the pod invite is gone
// by the time the person can sign in (the emailed link often opens in another
// tab, or later). The server keeps the invite on the account and redeems it
// when the link is clicked, with the same checks the redeem route applies.
const express = require('express');
const request = require('supertest');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { PodInvite } = require('../../models/PodInvite');
const AgentMessageService = require('../../services/agentMessageService');
const { sendEmail } = require('../../services/emailService');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, waitFor,
} = require('../utils/testUtils');

jest.mock('../../services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/communityPodService', () => ({ ensureUserInCommunityPod: jest.fn().mockResolvedValue(null) }));

const app = express();
app.use(express.json());
app.use('/api/auth', require('../../routes/auth'));

const email = 'invited-b@example.com';
const password = 'Password123!';
const MAIL_ENV = {
  SMTP2GO_API_KEY: 'test-key', SMTP2GO_FROM_EMAIL: 'hello@example.com', FRONTEND_URL: 'http://localhost:3000',
};
const ENV_KEYS = [...Object.keys(MAIL_ENV), 'AUTH_ALLOWED_DOMAINS', 'REGISTRATION_INVITE_ONLY'];

let welcome;
let pod;
let invite;

const register = async (body) => {
  await request(app).post('/api/auth/register').send({ email, password, ...body }).expect(201);
  // Onboarding runs on after the 201; let it finish before the next clear.
  await waitFor(() => welcome.mock.results.length > 0);
  await welcome.mock.results[0].value.catch(() => undefined);
  return User.findOne({ email });
};

// The newest link sent to this address, read back out of the message.
const linkFromEmail = async () => {
  await waitFor(() => sendEmail.mock.calls.length > 0);
  const { textBody } = sendEmail.mock.calls[sendEmail.mock.calls.length - 1][0];
  return new URL(textBody.match(/https?:\/\/\S+/)[0]);
};
const click = (link) => request(app).get(`/api/auth/verify-email${link.search}`);
const login = () => request(app).post('/api/auth/login').send({ email, password });
const isMember = async (userId) => (await Pod.findById(pod._id).lean()).members.map(String).includes(String(userId));
const pending = async (userId) => (await User.findById(userId).select('+pendingPodInvite').lean()).pendingPodInvite;
const uses = async () => (await PodInvite.findById(invite._id).lean()).useCount;

describe('register from a pod invite on a team-gated instance', () => {
  const saved = {};

  beforeAll(async () => {
    await setupMongoDb();
    process.env.JWT_SECRET = 'test-jwt-secret';
    ENV_KEYS.forEach((key) => { saved[key] = process.env[key]; });
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    welcome = jest.spyOn(AgentMessageService, 'postMessage');
    Object.assign(process.env, MAIL_ENV);
    process.env.REGISTRATION_INVITE_ONLY = 'false';
    process.env.AUTH_ALLOWED_DOMAINS = 'example.com';
    const inviter = await User.create({
      username: 'inviter-a', email: 'inviter-a@example.com', password: 'Password123!', verified: true,
    });
    pod = await Pod.create({ name: 'Team room', type: 'chat', createdBy: inviter._id, members: [inviter._id] });
    invite = await PodInvite.create({ token: 'a'.repeat(32), podId: pod._id, createdBy: inviter._id });
  });
  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    ENV_KEYS.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  test('clicking the emailed link joins the invited pod and names it; sign-in then works', async () => {
    const user = await register({ podInvite: invite.token });
    await login().expect(403);
    expect(await isMember(user._id)).toBe(false);
    expect(await uses()).toBe(0);
    // Kept off ordinary reads: it is a capability for someone else's pod.
    expect(user.pendingPodInvite).toBeUndefined();
    expect(await pending(user._id)).toBe(invite.token);

    const res = await click(await linkFromEmail()).expect(200);
    expect(res.body.podId).toBe(String(pod._id));
    expect(await isMember(user._id)).toBe(true);
    expect(await uses()).toBe(1);
    expect(await pending(user._id)).toBeUndefined();
    await login().expect(200);

    // Spent on the account: a second click joins nothing and counts nothing.
    const again = await click(await linkFromEmail()).expect(200);
    expect(again.body.podId).toBeUndefined();
    expect(await uses()).toBe(1);
  });

  test('a resent link still carries the invite', async () => {
    const user = await register({ podInvite: invite.token });
    await request(app).post('/api/auth/resend-verification').send({ email }).expect(200);
    await waitFor(() => sendEmail.mock.calls.length > 1);
    const res = await click(await linkFromEmail()).expect(200);
    expect(res.body.podId).toBe(String(pod._id));
    expect(await isMember(user._id)).toBe(true);
  });

  test.each([
    ['revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['used up', { maxUses: 1, useCount: 1 }],
  ])('an invite %s by the time the link is clicked grants nothing', async (_label, change) => {
    const user = await register({ podInvite: invite.token });
    await PodInvite.updateOne({ _id: invite._id }, { $set: change });
    const res = await click(await linkFromEmail()).expect(200);
    expect(res.body.podId).toBeUndefined();
    expect(await isMember(user._id)).toBe(false);
    expect((await User.findById(user._id)).verified).toBe(true);
  });

  test.each([
    ['an unknown token', 'b'.repeat(32)],
    ['a malformed token', { $ne: null }],
  ])('%s neither fails sign-up nor grants anything', async (_label, podInvite) => {
    const user = await register({ podInvite });
    expect(await pending(user._id)).toBeUndefined();
    const res = await click(await linkFromEmail()).expect(200);
    expect(res.body.podId).toBeUndefined();
    expect(await isMember(user._id)).toBe(false);
  });

  test.each([
    ['banned', { banned: true }],
    ['being deleted', { accountDeletionRequestedAt: new Date() }],
  ])('an account %s before it verifies joins nothing, and the invite is still spent', async (_label, change) => {
    const user = await register({ podInvite: invite.token });
    await User.updateOne({ _id: user._id }, { $set: change });
    const res = await click(await linkFromEmail()).expect(200);
    expect(res.body.podId).toBeUndefined();
    expect(await isMember(user._id)).toBe(false);
    expect(await uses()).toBe(0);
    expect(await pending(user._id)).toBeUndefined();
    expect((await User.findById(user._id)).verified).toBe(true);
  });

  test('a personal DM pod invite grants nothing', async () => {
    await Pod.updateOne({ _id: pod._id }, { $set: { type: 'agent-room' } });
    const user = await register({ podInvite: invite.token });
    expect(await pending(user._id)).toBeUndefined();
    const res = await click(await linkFromEmail()).expect(200);
    expect(res.body.podId).toBeUndefined();
    expect(await isMember(user._id)).toBe(false);
  });

  test('an open instance keeps nothing on the account: the signed-in tab joins as before', async () => {
    delete process.env.AUTH_ALLOWED_DOMAINS;
    const user = await register({ podInvite: invite.token });
    expect(await pending(user._id)).toBeUndefined();
    const res = await click(await linkFromEmail()).expect(200);
    expect(res.body.podId).toBeUndefined();
    expect(await isMember(user._id)).toBe(false);
    expect(await uses()).toBe(0);
  });
});
