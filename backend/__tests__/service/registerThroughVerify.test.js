// Register through verify over the public HTTP surface, with only the mail
// provider stubbed. Staging refuses email signup and we create no prod accounts,
// so nothing walks this path: this test is its proof until real volume exists.
const express = require('express');
const request = require('supertest');
const User = require('../../models/User');
const AgentMessageService = require('../../services/agentMessageService');
const { sendEmail } = require('../../services/emailService');
const { issueEmailVerificationToken } = require('../../services/emailVerificationTokenService');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, waitFor,
} = require('../utils/testUtils');

jest.mock('../../services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/communityPodService', () => ({ ensureUserInCommunityPod: jest.fn().mockResolvedValue(null) }));
// Count the handler's calls to the mark. The call is synchronous, before the
// response, so "never called" is settled once the request returns, with no
// sleep. A plain function, not jest.fn, so restoreMocks leaves it working.
jest.mock('../../services/onboardingMarks', () => {
  const actual = jest.requireActual('../../services/onboardingMarks');
  const calls = [];
  return {
    ...actual,
    markEmailVerified: (id) => { calls.push(String(id)); actual.markEmailVerified(id); },
    markEmailVerifiedCalls: calls,
  };
});
const { markEmailVerifiedCalls } = require('../../services/onboardingMarks');

const app = express();
app.use(express.json());
app.use('/api/auth', require('../../routes/auth'));

const email = 'first-signup@example.com';
const password = 'Password123!';

// Workspace onboarding runs on after the 201 and ends with the guide's
// welcome. Wait for it, so none of its writes outlives clearMongoDb or teardown.
let welcome;
const register = async () => {
  await request(app).post('/api/auth/register').send({ email, password }).expect(201);
  await waitFor(() => welcome.mock.results.length > 0);
  await welcome.mock.results[0].value.catch(() => undefined);
  return User.findOne({ email });
};

// The link the person received, read back out of the message we sent.
const linkFromEmail = async () => {
  await waitFor(() => sendEmail.mock.calls.length > 0);
  const [{ to, textBody }] = sendEmail.mock.calls[0];
  expect(to).toBe(email);
  return new URL(textBody.match(/https?:\/\/\S+/)[0]);
};

const click = (link) => request(app).get(`/api/auth/verify-email${link.search}`);
const mark = async (id) => (await User.findById(id).lean()).onboarding?.verifiedAt;

describe('register through verify', () => {
  const saved = {};
  const MAIL_ENV = {
    SMTP2GO_API_KEY: 'test-key', SMTP2GO_FROM_EMAIL: 'hello@example.com', FRONTEND_URL: 'http://localhost:3000',
  };

  beforeAll(async () => {
    await setupMongoDb();
    process.env.JWT_SECRET = 'test-jwt-secret';
    Object.keys(MAIL_ENV).forEach((key) => { saved[key] = process.env[key]; });
  });
  afterAll(closeMongoDb);
  beforeEach(() => {
    welcome = jest.spyOn(AgentMessageService, 'postMessage');
    Object.assign(process.env, MAIL_ENV);
    process.env.REGISTRATION_INVITE_ONLY = 'false';
  });
  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    markEmailVerifiedCalls.length = 0;
    Object.keys(MAIL_ENV).forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
    delete process.env.REGISTRATION_INVITE_ONLY;
  });

  test('the emailed link verifies the account and writes the mark once', async () => {
    const before = Date.now();
    const user = await register();
    expect(user.verified).toBe(false);
    expect(await mark(user._id)).toBeUndefined();

    const link = await linkFromEmail();
    expect(link.pathname).toBe('/verify-email');
    await click(link).expect(200);

    await waitFor(async () => Boolean(await mark(user._id)));
    expect((await User.findById(user._id)).verified).toBe(true);
    const first = await mark(user._id);
    expect(first.getTime()).toBeGreaterThanOrEqual(before);

    await click(link).expect(200);
    expect(markEmailVerifiedCalls).toEqual([String(user._id)]);
    expect((await mark(user._id)).getTime()).toBe(first.getTime());
  });

  test('sign-in does not wait on verifying', async () => {
    const user = await register();
    await request(app).post('/api/auth/login').send({ email, password }).expect(200);
    expect((await User.findById(user._id)).verified).toBe(false);
  });

  test('a bad link changes nothing', async () => {
    const user = await register();
    await request(app).get('/api/auth/verify-email?token=not-a-token').expect(400);
    expect(markEmailVerifiedCalls).toEqual([]);
    expect((await User.findById(user._id)).verified).toBe(false);
    expect(await mark(user._id)).toBeUndefined();
  });

  test('a password reset verifies the account without the mark, and a later link adds none', async () => {
    const user = await register();
    const link = await linkFromEmail();
    sendEmail.mockClear();

    await request(app).post('/api/auth/forgot-password').send({ email }).expect(200);
    await waitFor(() => sendEmail.mock.calls.length > 0);
    const reset = new URL(sendEmail.mock.calls[0][0].textBody.match(/https?:\/\/\S+/)[0]);
    await request(app).post('/api/auth/reset-password')
      .send({ token: reset.searchParams.get('token'), password: 'Different123!' }).expect(200);
    expect((await User.findById(user._id)).verified).toBe(true);

    await click(link).expect(200);
    expect(markEmailVerifiedCalls).toEqual([]);
    expect(await mark(user._id)).toBeUndefined();
  });

  test('an account that never took the step gets no mark, even from a link', async () => {
    delete process.env.SMTP2GO_API_KEY;
    const user = await register();
    expect(user.verified).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();

    await request(app).get(`/api/auth/verify-email?token=${issueEmailVerificationToken(user._id)}`).expect(200);
    expect(markEmailVerifiedCalls).toEqual([]);
    expect(await mark(user._id)).toBeUndefined();
  });
});
