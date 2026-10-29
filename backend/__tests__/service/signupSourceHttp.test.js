const express = require('express');
const request = require('supertest');
const axios = require('axios');
const User = require('../../models/User');
const OAuthLoginState = require('../../models/OAuthLoginState');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('../../services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/communityPodService', () => ({ ensureUserInCommunityPod: jest.fn().mockResolvedValue(undefined) }));

const app = express();
app.use(express.json());
app.use('/api/auth', require('../../routes/auth'));

describe('signup source over the public HTTP auth surface', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(() => {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'source-test-client';
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'source-test-secret';
    process.env.REGISTRATION_INVITE_ONLY = 'false';
    delete process.env.AUTH_ALLOWED_EMAILS;
    delete process.env.AUTH_ALLOWED_DOMAINS;
    delete process.env.SMTP2GO_API_KEY;
  });
  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    delete process.env.REGISTRATION_INVITE_ONLY;
  });

  it('refuses dollar-prefixed OAuth form keys before creating server state', async () => {
    const refused = await request(app).post('/api/auth/oauth/github/start').type('form')
      .send('$gt=1').expect(400);
    expect(refused.body).toMatchObject({ code: 'dollar_key_refused', field: 'body.$gt' });
    expect(await OAuthLoginState.countDocuments({})).toBe(0);
  });

  it('carries bounded form attribution in server state through callback and ignores replay', async () => {
    const source = { ref: 'HN', landingPath: `/${'%2F'.repeat(480)}?email=private`,
      referrer: `https://news.example/${'%2F'.repeat(480)}?token=private`, firstSeenAt: '2026-01-01T00:00:00.000Z' };
    expect(new URLSearchParams({ signupSource: JSON.stringify(source) }).toString().length).toBeGreaterThan(4096);
    const response = await request(app).post('/api/auth/oauth/github/start').type('form')
      .send({ signupSource: JSON.stringify(source) }).expect(302);
    expect(response.headers.location).not.toMatch(/signupSource|landingPath|private/);
    const state = new URL(response.headers.location).searchParams.get('state');
    const stored = await OAuthLoginState.findOne({ state });
    expect(stored.signupSource.landingPath).toBe(source.landingPath.split('?')[0]);
    expect(JSON.stringify(stored.signupSource)).not.toContain('private');
    expect(stored.signupSource.referrer).toBe('https://news.example');
    axios.post.mockResolvedValue({ data: { access_token: 'source-test-access' } });
    axios.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith('/emails')
      ? [{ email: 'source-http@example.com', verified: true, primary: true }]
      : { id: 4245, login: 'source-http' } }));
    const callback = `/api/auth/oauth/github/callback?state=${state}&code=source-code`;
    await request(app).get(`${callback}&signupSource=forged`).set('Cookie', response.headers['set-cookie'].map((cookie) => cookie.split(';')[0])).expect(302);
    const user = await User.findOne({ email: 'source-http@example.com' }).select('+signupSource');
    expect(user.signupSource.authMethod).toBe('github');
    expect(user.signupSource.ref).toBe('hn');
    const replay = await request(app).get(callback).expect(302);
    expect(replay.headers.location).toContain('oauthError=state_invalid');
    expect(await User.countDocuments({ email: 'source-http@example.com' })).toBe(1);
  });

  it('writes the password source only at registration, and never returns it in an ordinary profile read', async () => {
    await request(app).post('/api/auth/register').send({ email: 'password-source@example.com',
      password: 'Password123!', signupSource: { landingPath: '/v2/invite/SECRETinviteTOKEN123',
        referrer: 'https://news.example/v2/invite/SECRETinviteTOKEN123', ref: 'HN' } }).expect(201);
    const before = await User.findOne({ email: 'password-source@example.com' }).select('+signupSource');
    expect(before.signupSource.authMethod).toBe('password');
    expect(before.signupSource.landingPath).toBeUndefined();
    expect(before.signupSource.referrer).toBe('https://news.example');
    expect(JSON.stringify(before.signupSource)).not.toContain('SECRETinviteTOKEN123');
    const login = await request(app).post('/api/auth/login').send({ email: 'password-source@example.com',
      password: 'Password123!', signupSource: { ref: 'replacement' } }).expect(200);
    expect(JSON.stringify(login.body)).not.toContain('signupSource');
    const after = await User.findById(before._id).select('+signupSource');
    expect(after.signupSource.toObject()).toEqual(before.signupSource.toObject());
  });
});
