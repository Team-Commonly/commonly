const axios = require('axios');
const jwt = require('jsonwebtoken');
const User = require('../../../models/User');
const OAuthLoginState = require('../../../models/OAuthLoginState');
const InvitationCode = require('../../../models/InvitationCode');

jest.mock('../../../services/communityPodService', () => ({
  ensureUserInCommunityPod: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
const { ensureUserInCommunityPod } = require('../../../services/communityPodService');
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
const mockGithubProfile = ({ id = 4242, login = 'octo-dev', email = 'octo@example.com', verified = true } = {}) => {
  axios.post.mockResolvedValueOnce({ data: { access_token: 'gh-access-token' } });
  axios.get.mockImplementation((url) => {
    if (url.includes('/user/emails')) {
      return Promise.resolve({ data: [{ email, primary: true, verified }] });
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
    delete process.env.AUTH_ALLOWED_EMAILS;
    delete process.env.AUTH_ALLOWED_DOMAINS;
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    delete process.env.AUTH_ALLOWED_EMAILS;
    delete process.env.AUTH_ALLOWED_DOMAINS;
  });

  describe('signup source round trips', () => {
    it.each(['password', 'github', 'google'])('persists sanitized %s first touch once, never from callback parameters', async (method) => {
      const touch = {
        ref: 'HN', referrer: 'https://search.example/results?email=private#token',
        landingPath: '/guides/start?invite=private#token', firstSeenAt: '2026-01-01T00:00:00.000Z',
        authMethod: 'forged', recordedAt: '1900-01-01',
      };
      if (method === 'password') {
        const res = mockRes();
        await authController.register({ body: {
          username: 'source-user', email: 'source@example.com', password: 'Password123!', signupSource: touch,
        } }, res);
        expect(res.status).toHaveBeenCalledWith(201);
      } else {
        if (method === 'google') {
          process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
          process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
        }
        const signIn = async (source) => {
          const startRes = mockRes();
          await oauthController.startOAuth({ ...startReq(method), method: 'POST',
            body: { signupSource: JSON.stringify(source) } }, startRes);
          const location = startRes.redirect.mock.calls[0][0];
          expect(location).not.toMatch(/search\.example|landingPath|signupSource|private|firstSeenAt/);
          const state = new URL(location).searchParams.get('state');
          const storedState = await OAuthLoginState.findOne({ state });
          expect(JSON.stringify(storedState.signupSource)).not.toContain('private');
          if (method === 'github') mockGithubProfile({ email: 'source@example.com' });
          else {
            axios.post.mockResolvedValueOnce({ data: { access_token: 'google-access-token' } });
            axios.get.mockResolvedValue({ data: { sub: 'google-source', email: 'source@example.com',
              email_verified: true, name: 'source-user' } });
          }
          const callbackRes = mockRes();
          await oauthController.oauthCallback({ ...startReq(method),
            query: { code: 'provider-code', state, signupSource: JSON.stringify({ ref: 'forged' }), ref: 'forged' } }, callbackRes);
          expect(callbackRes.redirect).toHaveBeenCalledWith(expect.stringContaining('/v2/oauth/complete?'));
          expect(callbackRes.redirect.mock.calls[0][0]).not.toMatch(/signupSource|firstSeenAt|search\.example|private/);
          return { state, callbackRes };
        };
        const first = await signIn(touch);
        // A replay cannot create an account or overwrite its attribution.
        const replay = mockRes();
        await oauthController.oauthCallback({ ...startReq(method), query: { state: first.state, code: 'replay' } }, replay);
        expect(replay.redirect).toHaveBeenCalledWith(expect.stringContaining('oauthError=state_invalid'));
        await signIn({ ref: 'later', landingPath: '/later' });
      }
      const user = await User.findOne({ email: 'source@example.com' }).select('+signupSource');
      expect(user.signupSource.toObject()).toEqual({
        ref: 'hn', referrer: 'https://search.example/results', landingPath: '/guides/start',
        firstSeenAt: new Date('2026-01-01T00:00:00.000Z'), authMethod: method, recordedAt: expect.any(Date),
      });
      expect(user.onboarding.signupRef).toBe('hn');
      expect((await User.findById(user._id).lean()).signupSource).toBeUndefined();
      // Neither a later save nor a dotted update may rewrite a created source.
      user.signupSource.ref = 'changed';
      await user.save();
      await User.updateOne({ _id: user._id }, { $set: { 'signupSource.ref': 'also-changed' } });
      expect((await User.findById(user._id).select('+signupSource')).signupSource.ref).toBe('hn');
    });
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

    it('a form POST start reads next, invite and ref from the body, so the code stays out of the URL', async () => {
      const res = mockRes();
      await oauthController.startOAuth({
        method: 'POST',
        params: { provider: 'github' },
        // A query invite on a POST is ignored: only the body counts.
        query: { invite: 'FROM-QUERY' },
        body: { next: '/v2/pods/abc', invite: 'CODE2', ref: 'x' },
        protocol: 'https',
        get: () => 'api.test.local',
      }, res);

      expect(res.redirect).toHaveBeenCalledTimes(1);
      const url = new URL(res.redirect.mock.calls[0][0]);
      expect(url.toString()).not.toContain('CODE2');
      const state = await OAuthLoginState.findOne({ state: url.searchParams.get('state') });
      expect(state.invitationCode).toBe('CODE2');
      expect(state.next).toBe('/v2/pods/abc');
      expect(state.signupRef).toBe('x');
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

    it.each([
      ['protocol-relative', '//evil.example/x'],
      ['backslash, which browsers read as //', '/\\evil.example/x'],
      ['a control character', '/\t/evil.example'],
      ['dot-segment (normalises to //)', '/.//evil.example/x'],
      ['parent-segment (normalises to //)', '/x/..//evil.example/x'],
      ['encoded dot-segment', '/%2e//evil.example/x'],
    ])('rejects a %s next (open-redirect guard)', async (_label, next) => {
      const res = mockRes();
      await oauthController.startOAuth(startReq('github', { next }), res);
      const url = new URL(res.redirect.mock.calls[0][0]);
      const state = await OAuthLoginState.findOne({ state: url.searchParams.get('state') });
      expect(state.next).toBe('/v2');
    });

    it('carries a clean ?ref= into the login state, and drops a dirty one', async () => {
      const stateFor = async (ref) => {
        const res = mockRes();
        await oauthController.startOAuth(startReq('github', { ref }), res);
        const state = new URL(res.redirect.mock.calls[0][0]).searchParams.get('state');
        return OAuthLoginState.findOne({ state });
      };

      expect((await stateFor('X')).signupRef).toBe('x');
      expect((await stateFor('https://evil.example')).signupRef).toBe('');
    });

    it('keeps a deep link with its query (the re-engagement link)', async () => {
      const res = mockRes();
      await oauthController.startOAuth(startReq('github', { next: '/v2/agents/byo?mode=hosted' }), res);
      const url = new URL(res.redirect.mock.calls[0][0]);
      const state = await OAuthLoginState.findOne({ state: url.searchParams.get('state') });
      expect(state.next).toBe('/v2/agents/byo?mode=hosted');
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

    it('admits a verified, allowlisted provider email', async () => {
      process.env.AUTH_ALLOWED_EMAILS = ' OCTO@EXAMPLE.COM ';
      await seedState();
      mockGithubProfile();
      const res = mockRes();
      await oauthController.oauthCallback(callbackReq(), res);
      expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/v2/oauth/complete?'));
      expect(await User.findOne({ email: 'octo@example.com' })).toBeTruthy();
    });

    it('uses a verified team email when a personal email is primary on GitHub', async () => {
      process.env.AUTH_ALLOWED_DOMAINS = 'team.example';
      await seedState();
      axios.post.mockResolvedValueOnce({ data: { access_token: 'gh-access-token' } });
      axios.get.mockImplementation((url) => Promise.resolve(url.includes('/user/emails')
        ? { data: [
          { email: 'octo@personal.example', primary: true, verified: true },
          { email: 'octo@team.example', primary: false, verified: true },
        ] }
        : { data: { id: 4242, login: 'octo-dev' } }));
      const res = mockRes();
      await oauthController.oauthCallback(callbackReq(), res);
      expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/v2/oauth/complete?'));
      expect(await User.findOne({ email: 'octo@team.example' })).toBeTruthy();
      expect(await User.findOne({ email: 'octo@personal.example' })).toBeNull();
    });

    it('prefers an allowed primary over an allowed secondary even when listed second', async () => {
      process.env.AUTH_ALLOWED_DOMAINS = 'team.example';
      await seedState();
      axios.post.mockResolvedValueOnce({ data: { access_token: 'gh-access-token' } });
      axios.get.mockImplementation((url) => Promise.resolve(url.includes('/user/emails')
        ? { data: [
          { email: 'secondary@team.example', primary: false, verified: true },
          { email: 'primary@team.example', primary: true, verified: true },
        ] }
        : { data: { id: 4242, login: 'octo-dev' } }));
      const res = mockRes();
      await oauthController.oauthCallback(callbackReq(), res);
      expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/v2/oauth/complete?'));
      expect(await User.findOne({ email: 'primary@team.example' })).toBeTruthy();
      expect(await User.findOne({ email: 'secondary@team.example' })).toBeNull();
    });

    it('refuses an unlisted verified email before creating a user or exchange code', async () => {
      process.env.AUTH_ALLOWED_DOMAINS = 'team.example';
      await seedState();
      mockGithubProfile();
      const res = mockRes();
      await oauthController.oauthCallback(callbackReq(), res);
      expect(res.redirect).toHaveBeenCalledWith('https://app.test.local/v2/login?oauthError=team_only');
      expect(await User.countDocuments({ email: 'octo@example.com' })).toBe(0);
      expect((await OAuthLoginState.findOne({ state: 'state-1' })).exchangeCode).toBeUndefined();
    });

    it('refuses an existing linked account whose current address is outside the allowlist', async () => {
      process.env.AUTH_ALLOWED_EMAILS = 'octo@example.com';
      await User.create({ username: 'octo', email: 'old@example.com', verified: true,
        authProviders: [{ provider: 'github', providerId: '4242', email: 'octo@example.com' }] });
      await seedState();
      mockGithubProfile();
      const res = mockRes();
      await oauthController.oauthCallback(callbackReq(), res);
      expect(res.redirect).toHaveBeenCalledWith('https://app.test.local/v2/login?oauthError=team_only');
    });

    it('refuses an unverified provider email even if listed', async () => {
      process.env.AUTH_ALLOWED_EMAILS = 'octo@example.com';
      await seedState();
      mockGithubProfile({ verified: false });
      const res = mockRes();
      await oauthController.oauthCallback(callbackReq(), res);
      expect(res.redirect).toHaveBeenCalledWith('https://app.test.local/v2/login?oauthError=email_unverified');
      expect((await OAuthLoginState.findOne({ state: 'state-1' })).exchangeCode).toBeUndefined();
    });

    it.each([
      [true, '/v2/oauth/complete?'],
      [false, 'oauthError=email_unverified'],
    ])('uses Google’s verified email claim before team sign-in (verified=%s)', async (verified, destination) => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
      process.env.AUTH_ALLOWED_DOMAINS = 'team.example';
      await seedState({ provider: 'google' });
      axios.post.mockResolvedValueOnce({ data: { access_token: 'google-token' } });
      axios.get.mockResolvedValueOnce({ data: { sub: 'google-42', email: 'person@team.example',
        email_verified: verified, name: 'Person' } });
      const res = mockRes();
      await oauthController.oauthCallback({ ...callbackReq(), params: { provider: 'google' } }, res);
      expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining(destination));
      expect(await User.countDocuments({ email: 'person@team.example' })).toBe(verified ? 1 : 0);
    });

    it('redirects a failed token exchange without logging token-shaped error text', async () => {
      await seedState();
      axios.post.mockRejectedValueOnce(new Error('access_token=secret-value'));
      const log = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = mockRes();
        await oauthController.oauthCallback(callbackReq(), res);
        expect(res.redirect).toHaveBeenCalledWith('https://app.test.local/v2/login?oauthError=provider_error');
        expect(JSON.stringify(log.mock.calls)).not.toContain('secret-value');
      } finally {
        log.mockRestore();
      }
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
      expect(ensureUserInCommunityPod).toHaveBeenCalledWith(user._id);

      const redirectUrl = new URL(res.redirect.mock.calls[0][0]);
      expect(redirectUrl.origin).toBe('https://app.test.local');
      expect(redirectUrl.pathname).toBe('/v2/oauth/complete');
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
      expect(redirectUrl.searchParams.get('inviteSignup')).toBeNull();

      const state = await OAuthLoginState.findOne({ state: 'state-1' });
      expect(String(state.userId)).toBe(String(user._id));
      expect(state.usedAt).toBeTruthy();
    });

    // ?ref=x on the first visit reaches the provider round trip and is kept
    // on the account it creates; signing in to an existing one never sets it.
    it('a new account made through the provider keeps the signup ref', async () => {
      await seedState({ signupRef: 'x' });
      mockGithubProfile();

      await oauthController.oauthCallback(callbackReq(), mockRes());

      const user = await User.findOne({ email: 'octo@example.com' });
      expect(user.onboarding.signupRef).toBe('x');
    });

    it('signing in to an existing account does not set a signup ref', async () => {
      await User.create({
        username: 'octo-human', email: 'octo@example.com', password: 'hashed-pass', verified: true,
      });
      await seedState({ signupRef: 'x' });
      mockGithubProfile();
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      const user = await User.findOne({ email: 'octo@example.com' });
      expect(user.onboarding?.signupRef).toBeUndefined();
      const redirectUrl = new URL(res.redirect.mock.calls[0][0]);
      expect(redirectUrl.searchParams.get('inviteSignup')).toBeNull();
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
      // Counted over non-bot rows: TASK-149 queues the workspace onboarding off
      // the response path, and a previous test's Guide (a bot User) can land
      // between tests. The subject is 'linked, not duplicated' — a human row
      // count — and a count of every row would assert the timing of a
      // background step in another test.
      expect(await User.countDocuments({ isBot: { $ne: true } })).toBe(1);
      expect(ensureUserInCommunityPod).toHaveBeenCalledWith(existing._id);
    });

    it('refuses a bot row found by its linked provider (TASK-133)', async () => {
      // A converted account keeps whatever the person had linked, so the provider
      // arm can land on a bot row whose email no longer matches anything. The
      // email arm below already refused bots; this is the arm that never consults
      // the email.
      const bot = await User.create({
        username: 'converted-human',
        email: 'someone-else@example.com',
        isBot: true,
        authProviders: [{ provider: 'github', providerId: '4242', email: 'older@example.com' }],
      });
      // The environment leaks rows into this DB: finishWorkspaceOnboarding is
      // fired with `void` off the response path (authController.ts:338), so a
      // previous test's Guide (a scout-* agent) can land after that test's clear
      // and during this one — measured as 1 extra row on 5 runs of this file and
      // 2 on a sixth. Minted here so the count below is measured in the state the
      // leakage produces on every run, not only when the timing exposes it.
      await User.create({
        username: 'scout-ufixture',
        email: 'scout-ufixture@agents.commonly.local',
        password: 'hashed-pass',
        isBot: true,
        botType: 'agent',
      });
      await seedState();
      mockGithubProfile();
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      expect(res.redirect).toHaveBeenCalledWith(
        'https://app.test.local/v2/login?oauthError=bot_account',
      );
      expect(jwt.sign).not.toHaveBeenCalled();
      expect(String((await User.findById(bot._id))._id)).toBe(String(bot._id));
      // No second row was minted for the provider identity either — scoped to the
      // identity this test names, not to every row: a bare count asserts the
      // timing of the guide rows minted above rather than this test's subject.
      expect(await User.countDocuments({ 'authProviders.providerId': '4242' })).toBe(1);
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
      expect(await User.countDocuments({ isBot: { $ne: true } })).toBe(0);
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
      const redirectUrl = new URL(res.redirect.mock.calls[0][0]);
      expect(redirectUrl.searchParams.get('inviteSignup')).toBe('1');
    });

    it('grants cloudAgents when an invite code rides through /start under open registration', async () => {
      process.env.REGISTRATION_INVITE_ONLY = 'false';
      process.env.REGISTRATION_INVITE_CODES = 'LAUNCH-CREW';
      await seedState({ invitationCode: 'LAUNCH-CREW' });
      mockGithubProfile();
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      const user = await User.findOne({ email: 'octo@example.com' });
      expect(user.entitlements.cloudAgents).toBe(true);
    });

    it('creates a BYO-only account under open registration with no code', async () => {
      process.env.REGISTRATION_INVITE_ONLY = 'false';
      await seedState();
      mockGithubProfile();
      const res = mockRes();

      await oauthController.oauthCallback(callbackReq(), res);

      const user = await User.findOne({ email: 'octo@example.com' });
      expect(user.entitlements.cloudAgents).toBe(false);
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
      // Scoped to non-bot rows rather than every row: TASK-149 queues the
      // workspace onboarding off the response path, so a previous test's Guide
      // (a bot User) can land between tests. The subject here is that the
      // rejected profile got no ACCOUNT, and a count of all rows would be
      // asserting the absence of a background step from another test.
      expect(await User.countDocuments({ isBot: { $ne: true } })).toBe(0);
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

    it('refuses to issue a session for an account that is an agent (TASK-133)', async () => {
      // The state row records who signed in moments ago; the row can have become
      // an agent since, and this is the fifth place a `{ id }` 7-day session is
      // minted.
      const bot = await User.create({
        username: 'converted-human',
        email: 'converted@example.com',
        password: 'hashed-pass',
        isBot: true,
        verified: true,
      });
      await OAuthLoginState.create({
        provider: 'github',
        state: 'state-bot',
        userId: bot._id,
        exchangeCode: 'bot-code',
        exchangeExpiresAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 60000),
      });

      const res = mockRes();
      await oauthController.exchangeOAuthCode({ body: { code: 'bot-code' } }, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Agent accounts authenticate with their runtime token.',
        code: 'BOT_ACCOUNT',
      });
      expect(jwt.sign).not.toHaveBeenCalled();
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
