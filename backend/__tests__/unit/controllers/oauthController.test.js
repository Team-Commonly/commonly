const axios = require('axios');
const jwt = require('jsonwebtoken');
const User = require('../../../models/User');
const OAuthLoginState = require('../../../models/OAuthLoginState');
const InvitationCode = require('../../../models/InvitationCode');
const oauthController = require('../../../controllers/oauthController');
const authController = require('../../../controllers/authController');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn(),
}));

const mockRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
  redirect: jest.fn(),
});

const startReq = (provider, query = {}) => ({
  params: { provider },
  query,
  protocol: 'https',
  get: () => 'api.test.local',
});

// Wire axios mocks for a successful GitHub round-trip.
const mockGithubProfile = ({ id = 4242, login = 'octo-dev', email = 'octo@example.com' } = {}) => {
  axios.post.mockResolvedValueOnce({ data: { access_token: 'gh-access-token' } });
  axios.get.mockImplementation((url) => {
    if (url.includes('/user/emails')) {
      return Promise.resolve({ data: [{ email, primary: true, verified: true }] });
    }
    return Promise.resolve({ data: { id, login } });
  });
};

describe('OAuth Controller', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(() => {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
    process.env.FRONTEND_URL = 'https://app.test.local';
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.REGISTRATION_INVITE_ONLY;
    delete process.env.REGISTRATION_INVITE_CODES;
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  });

  describe('getOAuthProviders', () => {
    it('lists only configured providers', () => {
      const res = mockRes();
      oauthController.getOAuthProviders({}, res);
      expect(res.json).toHaveBeenCalledWith({
        providers: [{ id: 'github', label: 'GitHub' }],
      });
    });

    it('returns empty list when nothing is configured', () => {
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
      const res = mockRes();
      oauthController.getOAuthProviders({}, res);
      expect(res.json).toHaveBeenCalledWith({ providers: [] });
    });
  });

  describe('startOAuth', () => {
    it('mints a state row and redirects to the provider', async () => {
      const res = mockRes();
      await oauthController.startOAuth(startReq('github', { next: '/v2/pods/abc', invite: 'CODE1' }), res);

      expect(res.redirect).toHaveBeenCalledTimes(1);
      const url = new URL(res.redirect.mock.calls[0][0]);
      expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('gh-client');
      expect(url.searchParams.get('redirect_uri')).toBe('https://api.test.local/api/auth/oauth/github/callback');

      const state = await OAuthLoginState.findOne({ state: url.searchParams.get('state') });
      expect(state).toBeTruthy();
      expect(state.next).toBe('/v2/pods/abc');
      expect(state.invitationCode).toBe('CODE1');
    });

    it('serves consecutive starts — pending rows must not collide on the exchangeCode index', async () => {
      // Regression: exchangeCode had `default: null` + a sparse unique index.
      // Sparse skips MISSING fields but still indexes explicit nulls, so the
      // SECOND /start ever served threw E11000 and 500'd (2026-07-03 live
      // incident — GitHub worked once, then every provider start failed).
      const res1 = mockRes();
      const res2 = mockRes();
      await oauthController.startOAuth(startReq('github'), res1);
      await oauthController.startOAuth(startReq('github'), res2);

      expect(res1.redirect).toHaveBeenCalledTimes(1);
      expect(res2.redirect).toHaveBeenCalledTimes(1);
      expect(res2.status).not.toHaveBeenCalledWith(500);
      expect(await OAuthLoginState.countDocuments({})).toBe(2);
    });

    it('rejects absolute next URLs (open-redirect guard)', async () => {
      const res = mockRes();
      await oauthController.startOAuth(startReq('github', { next: 'https://evil.example' }), res);
      const url = new URL(res.redirect.mock.calls[0][0]);
      const state = await OAuthLoginState.findOne({ state: url.searchParams.get('state') });
      expect(state.next).toBe('/v2');
    });

    it('404s an unconfigured provider', async () => {
      const res = mockRes();
      await oauthController.startOAuth(startReq('google'), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('oauthCallback', () => {
    const seedState = (overrides = {}) => OAuthLoginState.create({
      provider: 'github',
      state: 'state-1',
      expiresAt: new Date(Date.now() + 60000),
      ...overrides,
    });

    const callbackReq = (query = {}) => ({
      params: { provider: 'github' },
      query: { code: 'gh-code', state: 'state-1', ...query },
      protocol: 'https',
      get: () => 'api.test.local',
    });

    it('creates a new verified passwordless user and redirects with an exchange code', async () => {
      await seedState();
      mockGithubProfile();
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      const user = await User.findOne({ email: 'octo@example.com' });
      expect(user).toBeTruthy();
      expect(user.verified).toBe(true);
      expect(user.password).toBeUndefined();
      expect(user.username).toBe('octo-dev');
      expect(user.authProviders).toHaveLength(1);
      expect(user.authProviders[0]).toMatchObject({ provider: 'github', providerId: '4242' });

      const redirectUrl = new URL(res.redirect.mock.calls[0][0]);
      expect(redirectUrl.origin).toBe('https://app.test.local');
      expect(redirectUrl.pathname).toBe('/v2/oauth/complete');
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();

      const state = await OAuthLoginState.findOne({ state: 'state-1' });
      expect(String(state.userId)).toBe(String(user._id));
      expect(state.usedAt).toBeTruthy();
    });

    it('links to an existing account with the same verified email', async () => {
      const existing = await User.create({
        username: 'octo-human',
        email: 'octo@example.com',
        password: 'hashed-pass',
        verified: false,
      });
      await seedState();
      mockGithubProfile();
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      const user = await User.findById(existing._id);
      expect(user.authProviders).toHaveLength(1);
      expect(user.authProviders[0].providerId).toBe('4242');
      expect(user.verified).toBe(true); // provider-asserted
      expect(await User.countDocuments({})).toBe(1); // linked, not duplicated
    });

    it('enforces the invite gate for brand-new signups', async () => {
      process.env.REGISTRATION_INVITE_ONLY = 'true';
      await seedState(); // no invitationCode captured at /start
      mockGithubProfile();
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining('oauthError=invitation_required'),
      );
      expect(await User.countDocuments({})).toBe(0);
    });

    it('consumes a DB invitation code captured at /start', async () => {
      process.env.REGISTRATION_INVITE_ONLY = 'true';
      const admin = await User.create({
        username: 'admin-user',
        email: 'admin@example.com',
        password: 'hashed-pass',
        role: 'admin',
      });
      await InvitationCode.create({
        code: 'WELCOME1',
        isActive: true,
        maxUses: 1,
        useCount: 0,
        createdBy: admin._id,
      });
      await seedState({ invitationCode: 'WELCOME1' });
      mockGithubProfile();
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      expect(await User.countDocuments({ email: 'octo@example.com' })).toBe(1);
      const invite = await InvitationCode.findOne({ code: 'WELCOME1' });
      expect(invite.useCount).toBe(1);
    });

    it('rejects a replayed state (single-use)', async () => {
      await seedState({ usedAt: new Date() });
      const res = mockRes();
      await oauthController.oauthCallback(callbackReq(), res);
      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining('oauthError=state_invalid'),
      );
    });

    it('rejects a profile without a verified email', async () => {
      await seedState();
      axios.post.mockResolvedValueOnce({ data: { access_token: 'gh-access-token' } });
      axios.get.mockImplementation((url) => {
        if (url.includes('/user/emails')) {
          return Promise.resolve({ data: [{ email: 'octo@example.com', primary: true, verified: false }] });
        }
        return Promise.resolve({ data: { id: 4242, login: 'octo-dev' } });
      });
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining('oauthError=email_unverified'),
      );
      expect(await User.countDocuments({})).toBe(0);
    });

    it('suffixes the username when the provider handle is taken', async () => {
      await User.create({
        username: 'octo-dev',
        email: 'other@example.com',
        password: 'hashed-pass',
      });
      await seedState();
      mockGithubProfile();
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      const user = await User.findOne({ email: 'octo@example.com' });
      expect(user.username).toMatch(/^octo-dev-[0-9a-f]{4}$/);
    });
  });

  describe('exchangeOAuthCode', () => {
    it('issues a session once and only once per code', async () => {
      const user = await User.create({
        username: 'octo-dev',
        email: 'octo@example.com',
        verified: true,
        authProviders: [{ provider: 'github', providerId: '4242', email: 'octo@example.com' }],
      });
      await OAuthLoginState.create({
        provider: 'github',
        state: 'state-2',
        userId: user._id,
        exchangeCode: 'one-time-code',
        exchangeExpiresAt: new Date(Date.now() + 60000),
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      });

      const res1 = mockRes();
      await oauthController.exchangeOAuthCode({ body: { code: 'one-time-code' } }, res1);
      expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({
        token: 'test-jwt-token',
        user: expect.objectContaining({ username: 'octo-dev' }),
      }));

      const res2 = mockRes();
      await oauthController.exchangeOAuthCode({ body: { code: 'one-time-code' } }, res2);
      expect(res2.status).toHaveBeenCalledWith(400);
    });

    it('rejects an expired exchange code', async () => {
      const user = await User.create({
        username: 'octo-dev',
        email: 'octo@example.com',
        verified: true,
        authProviders: [{ provider: 'github', providerId: '4242' }],
      });
      await OAuthLoginState.create({
        provider: 'github',
        state: 'state-3',
        userId: user._id,
        exchangeCode: 'stale-code',
        exchangeExpiresAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 60000),
      });

      const res = mockRes();
      await oauthController.exchangeOAuthCode({ body: { code: 'stale-code' } }, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('login guard for OAuth-only accounts', () => {
    it('tells a passwordless user to use their provider instead of throwing', async () => {
      await User.create({
        username: 'octo-dev',
        email: 'octo@example.com',
        verified: true,
        authProviders: [{ provider: 'github', providerId: '4242' }],
      });

      const res = mockRes();
      await authController.login({ body: { email: 'octo@example.com', password: 'whatever' } }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'OAUTH_ONLY_ACCOUNT',
      }));
    });
  });
});
