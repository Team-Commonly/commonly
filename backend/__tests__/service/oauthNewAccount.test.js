/** TASK-524: first OAuth signup through real HTTP, models and session auth.
 * Only upstream provider HTTP responses are stubbed. Run on Tier 1 real DBs.
 */
const express = require('express');
const request = require('supertest');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const { SCOUT_WELCOME } = require('../../config/native-agents/scout');
const OAuthLoginState = require('../../models/OAuthLoginState');
const authRoutes = require('../../routes/auth');
const podRoutes = require('../../routes/pods');
const { setupMongoDb, closeMongoDb, setupPgDb, closePgDb, waitFor } = require('../utils/testUtils');

const tier1 = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
tier1('new-account OAuth — Google and GitHub', () => {
  let app;
  const envKeys = ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET', 'FRONTEND_URL', 'REGISTRATION_INVITE_ONLY'];
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  beforeAll(async () => {
    await setupMongoDb();
    await setupPgDb();
    process.env.FRONTEND_URL = 'http://localhost:3000';
    process.env.REGISTRATION_INVITE_ONLY = 'false';
    for (const key of envKeys.filter((key) => key.includes('OAUTH_CLIENT'))) process.env[key] = 'oauth-test-only';
    app = express();
    app.use(express.json());
    // Production routers and middleware; no hand-written auth substitutes.
    app.use('/api/auth', authRoutes);
    app.use('/api/pods', podRoutes);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    // Each case waits for the queued starter tasks and Scout welcome before
    // teardown, not just the earlier PostgreSQL mirror.
    const { pool } = require('../../config/db-pg');
    if (pool) await pool.end();
    await closePgDb();
    await closeMongoDb();
    for (const key of envKeys) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  });

  test.each(['google', 'github'])('%s creates a human, issues the first session and supplies an app landing workspace', async (provider) => {
    const email = `new-${provider}@oauth-524.test`;
    const providerId = provider === 'google' ? 'google-new-524' : '524001';
    expect(await User.findOne({ email })).toBeNull();
    const tokenPost = jest.spyOn(axios, 'post').mockImplementation(async (url) => {
      const expected = provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://github.com/login/oauth/access_token';
      if (url !== expected) throw new Error(`Unexpected provider POST: ${url}`);
      return { data: { access_token: 'provider-test-only' } };
    });
    jest.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (provider === 'google' && url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return { data: { sub: providerId, email, email_verified: true, name: 'New Google Person' } };
      }
      if (provider === 'github' && url === 'https://api.github.com/user') {
        return { data: { id: Number(providerId), login: 'new-github-person' } };
      }
      if (provider === 'github' && url === 'https://api.github.com/user/emails') {
        return { data: [{ email, verified: true, primary: true }] };
      }
      throw new Error(`Unexpected provider GET: ${url}`);
    });

    const start = await request(app).get(`/api/auth/oauth/${provider}/start?next=/v2`).expect(302);
    const upstream = new URL(start.headers.location);
    const state = upstream.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(await OAuthLoginState.findOne({ provider, state })).toBeTruthy();
    const callbackPath = `/api/auth/oauth/${provider}/callback?state=${encodeURIComponent(state)}&code=provider-code`;
    const callback = await request(app).get(callbackPath).expect(302);
    const landing = new URL(callback.headers.location);
    expect({ origin: landing.origin, path: landing.pathname, next: landing.searchParams.get('next') })
      .toEqual({ origin: 'http://localhost:3000', path: '/v2/oauth/complete', next: '/v2' });
    expect(landing.searchParams.has('token')).toBe(false);
    const code = landing.searchParams.get('code');
    expect(code).toMatch(/^[a-f0-9]{48}$/);

    const created = await User.findOne({ email });
    expect(created).toBeTruthy();
    expect(created.isBot).toBe(false);
    expect(created.verified).toBe(true);
    expect(created.authProviders.some((entry) => entry.provider === provider && entry.providerId === providerId)).toBe(true);
    const workspace = await Pod.findOne({ createdBy: created._id, name: 'My Workspace' });
    expect(workspace).toBeTruthy();
    expect(workspace.members.map(String)).toContain(String(created._id));
    expect(workspace.joinPolicy).toBe('invite-only');

    // This is the exact exchange and bearer token used by V2OAuthComplete
    // and AuthContext, not a JWT minted by the test fixture.
    const session = await request(app).post('/api/auth/oauth/exchange').send({ code }).expect(200);
    expect(session.body.token).toEqual(expect.any(String));
    expect(jwt.verify(session.body.token, process.env.JWT_SECRET).id).toBe(String(created._id));
    const protectedState = (row) => ({
      exchangeCode: row.exchangeCode, userId: String(row.userId),
      usedAt: row.usedAt.toISOString(), exchangedAt: row.exchangedAt.toISOString(),
    });
    const stateSnapshot = protectedState(await OAuthLoginState.findOne({ state }));
    const authorization = `Bearer ${session.body.token}`;
    const current = await request(app).get('/api/auth/user').set('Authorization', authorization).expect(200);
    expect(JSON.stringify(current.body)).toContain(email);
    const pods = await request(app).get('/api/pods').set('Authorization', authorization).expect(200);
    expect(pods.body.some((entry) => String(entry._id || entry.id) === String(workspace._id))).toBe(true);
    // Wait through the observable onboarding tail, rather than closing the
    // database after only its first (PG mirror) step has completed.
    await waitFor(async () => {
      const { pool } = require('../../config/db-pg');
      const welcome = await pool.query('SELECT id FROM messages WHERE pod_id=$1 AND content=$2', [String(workspace._id), SCOUT_WELCOME]);
      const membership = await pool.query('SELECT p.id FROM pods p JOIN pod_members m ON m.pod_id=p.id WHERE p.id=$1 AND m.user_id=$2', [String(workspace._id), String(created._id)]);
      return membership.rows.length === 1 && welcome.rows.length > 0 && await Task.countDocuments({ podId: workspace._id, source: 'onboarding' }) === 3;
    }, { timeout: 15000 });

    const replay = await request(app).get(callbackPath).expect(302);
    expect(replay.headers.location).toContain('state_invalid');
    expect(protectedState(await OAuthLoginState.findOne({ state }))).toEqual(stateSnapshot);
    expect(tokenPost).toHaveBeenCalledTimes(1);
    await request(app).post('/api/auth/oauth/exchange').send({ code }).expect(400);
    expect(protectedState(await OAuthLoginState.findOne({ state }))).toEqual(stateSnapshot);
    expect(await User.countDocuments({ email })).toBe(1);
    expect(await Pod.countDocuments({ createdBy: created._id, name: 'My Workspace' })).toBe(1);
    const consumed = await OAuthLoginState.findOne({ state });
    expect(consumed.usedAt).toBeTruthy();
    expect(consumed.exchangedAt).toBeTruthy();
  });
});
