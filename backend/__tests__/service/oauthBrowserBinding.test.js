const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const User = require('../../models/User');
const OAuthLoginState = require('../../models/OAuthLoginState');
const { corsOptions } = require('../../middleware/corsPolicy');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('../../services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/communityPodService', () => ({ ensureUserInCommunityPod: jest.fn().mockResolvedValue(undefined) }));

const app = express();
app.set('trust proxy', 1);
app.use(cors(corsOptions(['https://app.test.local'])));
app.use(express.json());
app.use('/api/auth', require('../../routes/auth'));
const cookiePairs = (res) => (res.headers['set-cookie'] || []).map((value) => value.split(';')[0]);
const withBrowser = (call, cookies = []) => call.set('Host', 'api.test.local').set('X-Forwarded-Proto', 'https').set('Cookie', cookies);
const challengeFor = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
const callback = (flow, state = flow.state) => `/api/auth/oauth/${flow.provider}/callback?state=${state}&code=provider-code`;
const start = async (provider) => {
  const res = await withBrowser(request(app).get(`/api/auth/oauth/${provider}/start?next=/v2/pods/home`)).expect(302);
  const url = new URL(res.headers.location);
  return { provider, url, state: url.searchParams.get('state'), cookies: cookiePairs(res), res };
};
const stubProvider = (flow) => {
  axios.post.mockImplementation(async (url, body) => {
    const data = typeof body === 'string' ? Object.fromEntries(new URLSearchParams(body)) : body;
    if (!data.code_verifier || challengeFor(data.code_verifier) !== flow.url.searchParams.get('code_challenge')) {
      throw new Error('invalid_grant');
    }
    expect(data.client_secret).toBe(`${flow.provider}-secret`);
    expect(data.redirect_uri).toBe(`https://api.test.local/api/auth/oauth/${flow.provider}/callback`);
    return { data: { access_token: 'synthetic-provider-token' } };
  });
  axios.get.mockImplementation(async (url) => ({ data: url.endsWith('/emails')
    ? [{ email: 'person@example.com', primary: true, verified: true }]
    : flow.provider === 'github' ? { id: 1234, login: 'person' }
      : { sub: 'google-person', email: 'person@example.com', email_verified: true, name: 'person' } }));
};

describe('OAuth browser round trip over HTTP', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(() => {
    for (const provider of ['GITHUB', 'GOOGLE']) {
      process.env[`${provider}_OAUTH_CLIENT_ID`] = `${provider.toLowerCase()}-client`;
      process.env[`${provider}_OAUTH_CLIENT_SECRET`] = `${provider.toLowerCase()}-secret`;
    }
    process.env.FRONTEND_URL = 'https://app.test.local';
    delete process.env.OAUTH_CALLBACK_BASE_URL;
    delete process.env.REGISTRATION_INVITE_ONLY;
    delete process.env.AUTH_ALLOWED_EMAILS;
    delete process.env.AUTH_ALLOWED_DOMAINS;
  });
  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    for (const provider of ['GITHUB', 'GOOGLE']) {
      delete process.env[`${provider}_OAUTH_CLIENT_ID`];
      delete process.env[`${provider}_OAUTH_CLIENT_SECRET`];
    }
    delete process.env.FRONTEND_URL;
  });

  it.each(['github', 'google'])('completes %s across frontend/API origins with S256 and a single-use exchange', async (provider) => {
    const flow = await start(provider);
    const row = await OAuthLoginState.findOne({ state: flow.state }).select('+pkceVerifier');
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.url.searchParams.get('code_challenge')).toBe(challengeFor(row.pkceVerifier));
    expect(row.pkceVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.url.href).not.toContain(row.pkceVerifier);
    const cookie = flow.res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^__Host-cm-oauth-/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).not.toContain('Domain=');
    const nonce = flow.cookies[0].split('=')[1];
    expect(row.browserNonceHash).toBe(crypto.createHash('sha256').update(nonce).digest('hex'));
    expect(row.browserNonceHash).not.toBe(nonce);
    stubProvider(flow);
    const completed = await withBrowser(request(app).get(callback(flow)), flow.cookies).expect(302);
    expect(completed.headers.location).toContain('https://app.test.local/v2/oauth/complete?');
    expect(completed.headers.location).not.toMatch(/synthetic-provider-token|code_verifier|cm-oauth/);
    const code = new URL(completed.headers.location).searchParams.get('code');
    const denied = await withBrowser(request(app).post('/api/auth/oauth/exchange')).send({ code }).expect(400);
    expect(denied.body.token).toBeUndefined();
    const wrongCookies = [flow.cookies[0].replace(/=.*/, `=${'0'.repeat(64)}`)];
    await withBrowser(request(app).post('/api/auth/oauth/exchange'), wrongCookies).send({ code }).expect(400);
    expect((await OAuthLoginState.findOne({ state: flow.state })).exchangedAt).toBeNull();
    const exchanged = await withBrowser(request(app).post('/api/auth/oauth/exchange'), flow.cookies)
      .set('Origin', 'https://app.test.local').send({ code }).expect(200);
    expect(exchanged.headers['access-control-allow-origin']).toBe('https://app.test.local');
    expect(exchanged.headers['access-control-allow-credentials']).toBe('true');
    expect(jwt.verify(exchanged.body.token, process.env.JWT_SECRET).id).toBe(String((await User.findOne({ email: 'person@example.com' }))._id));
    expect(exchanged.headers['set-cookie'][0]).toContain(`${flow.cookies[0].split('=')[0]}=;`);
    expect((await OAuthLoginState.findOne({ state: flow.state }).select('+pkceVerifier')).pkceVerifier).toBeUndefined();
    await withBrowser(request(app).post('/api/auth/oauth/exchange'), flow.cookies).send({ code }).expect(400);
    const replay = await withBrowser(request(app).get(callback(flow)), flow.cookies).expect(302);
    expect(replay.headers.location).toContain('oauthError=state_invalid');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it.each(['missing cookie', 'wrong cookie', 'duplicate cookie', 'missing state', 'wrong state'])('refuses a callback with %s before provider calls or state consumption', async (invalid) => {
    const flow = await start('google');
    let cookies = flow.cookies;
    if (invalid === 'missing cookie') cookies = [];
    if (invalid === 'wrong cookie') cookies = [flow.cookies[0].replace(/=.*/, `=${'0'.repeat(64)}`)];
    if (invalid === 'duplicate cookie') cookies = [...flow.cookies, ...flow.cookies];
    const url = invalid === 'missing state' ? '/api/auth/oauth/google/callback?code=x'
      : callback(flow, invalid === 'wrong state' ? 'f'.repeat(48) : flow.state);
    const res = await withBrowser(request(app).get(url), cookies).expect(302);
    expect(res.headers.location).toContain('oauthError=state_invalid');
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(await User.countDocuments({})).toBe(0);
    const row = await OAuthLoginState.findOne({ state: flow.state });
    expect(row.usedAt).toBeNull();
    expect(row.exchangeCode).toBeUndefined();
  });

  it.each(['github', 'google'].flatMap((provider) => [[provider, 'mismatched'], [provider, 'missing']]))('refuses a %s attempt with a %s verifier', async (provider, kind) => {
    const flow = await start(provider);
    stubProvider(flow);
    const missing = kind === 'missing';
    await OAuthLoginState.updateOne({ state: flow.state }, missing
      ? { $unset: { pkceVerifier: 1 } } : { $set: { pkceVerifier: 'x'.repeat(43) } });
    const res = await withBrowser(request(app).get(callback(flow)), flow.cookies).expect(302);
    expect(res.headers.location).toContain(`oauthError=${missing ? 'state_invalid' : 'provider_error'}`);
    expect(await User.countDocuments({})).toBe(0);
    expect((await OAuthLoginState.findOne({ state: flow.state })).exchangeCode).toBeUndefined();
    expect(axios.post).toHaveBeenCalledTimes(missing ? 0 : 1);
  });

  it('refuses an expired bound attempt without consuming it', async () => {
    const flow = await start('google');
    // Keep the row present: exercise the time predicate rather than the TTL reaper.
    await OAuthLoginState.updateOne({ state: flow.state }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await withBrowser(request(app).get(callback(flow)), flow.cookies).expect(302);
    expect(res.headers.location).toContain('oauthError=state_invalid');
    expect(axios.post).not.toHaveBeenCalled();
    expect(await User.countDocuments({})).toBe(0);
    expect((await OAuthLoginState.findOne({ state: flow.state })).usedAt).toBeNull();
  });

  it('keeps parallel starts independent and refuses an old unbound attempt', async () => {
    const first = await start('github');
    const second = await start('github');
    expect(first.cookies[0].split('=')[0]).not.toBe(second.cookies[0].split('=')[0]);
    stubProvider(first);
    await withBrowser(request(app).get(callback(first)), [...first.cookies, ...second.cookies]).expect(302);
    expect((await OAuthLoginState.findOne({ state: second.state })).usedAt).toBeNull();
    stubProvider(second);
    await withBrowser(request(app).get(callback(second)), [...first.cookies, ...second.cookies]).expect(302);
    expect(await User.countDocuments({ email: 'person@example.com' })).toBe(1);
    const legacy = await start('google');
    await OAuthLoginState.updateOne({ state: legacy.state }, { $unset: { browserNonceHash: 1, pkceVerifier: 1 } });
    const res = await withBrowser(request(app).get(callback(legacy)), legacy.cookies).expect(302);
    expect(res.headers.location).toContain('oauthError=state_invalid');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});
