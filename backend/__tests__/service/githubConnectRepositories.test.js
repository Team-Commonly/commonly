/**
 * F172 at the service tier: self-serve Commonly Connect repository
 * connections, and the per-repository uniqueness both GitHub App routes share.
 *
 * Real: memory Mongo (Integration with its indexes, User, RoomGrant), the
 * integrations router, adminAuth, the proof service, the grant service.
 * Mocked: the auth middleware (a header picks the caller), the rate limiters,
 * GitHub (at `hostedVendorFetch`, the seam the proof calls through) and the
 * hosted-MCP credential opener (the row's stored token is returned as is).
 */
process.env.PG_HOST = '';
const express = require('express');
const request = require('supertest');
const { generateKeyPairSync } = require('crypto');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../middleware/auth', () => (req, res, next) => {
  const id = String(req.header('x-test-user') || '');
  if (!id) return res.status(401).json({ message: 'no user' });
  req.user = { id };
  req.userId = id;
  return next();
});
jest.mock('../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));

// Fake GitHub, keyed by user token: which installations it sees and, per
// installation, which repositories with what permission.
const mockGithub = { byToken: {}, requests: [] };
jest.mock('../../services/hostedVendorFetch', () => ({
  hostedVendorFetch: jest.fn(async (url, init) => {
    const token = String(init?.headers?.Authorization || '').replace('Bearer ', '');
    mockGithub.requests.push({ url, token });
    const view = mockGithub.byToken[token];
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (!view) return json(401, { message: 'Bad credentials' });
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page') || 1);
    if (parsed.pathname === '/user/installations') {
      return json(200, { total_count: view.installations.length, installations: page === 1 ? view.installations : [] });
    }
    const match = parsed.pathname.match(/^\/user\/installations\/(\d+)\/repositories$/);
    if (match) {
      const repos = view.repositories[match[1]];
      if (!repos) return json(404, { message: 'Not Found' });
      return json(200, { total_count: repos.length, repositories: page === 1 ? repos : [] });
    }
    return json(404, { message: 'Not Found' });
  }),
}));
jest.mock('../../services/hostedMcpCredentialService', () => ({
  credentialFor: jest.fn(async (row) => ({ token: String(row.config?.credentialRef || ''), expiresAt: '' })),
}));
jest.mock('../../services/brokerRecordService', () => ({
  recordBrokerCall: jest.fn(),
  recordApprovalOutcome: jest.fn(),
  recordGrantExpired: jest.fn(),
  recordGrantsRevoked: jest.fn(),
  recordGrantIssued: jest.fn(),
}));

const User = require('../../models/User');
const Integration = require('../../models/Integration');
const RoomGrant = require('../../models/RoomGrant');
const { createGrant } = require('../../services/roomGrantService');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { hostedVendorFetch } = require('../../services/hostedVendorFetch');

const CONNECT_APP_ID = '424242';
const INSTALL = '7001';
const OTHER_INSTALL = '7002';

let app;
let alice;
let bob;
let admin;
let bot;

const repo = (fullName, permissions = { push: true, pull: true }) => {
  const [login, name] = fullName.split('/');
  return {
    name, full_name: fullName, owner: { login }, permissions, 
  };
};

const giveUserToken = (user, token) => Integration.create({
  type: 'hosted-mcp',
  scope: 'user',
  status: 'connected',
  createdBy: user._id,
  isActive: true,
  config: { entryId: 'github-mcp', credentialRef: token, intake: 'oauth' },
});

const connectRepo = (user, body) => request(app).post('/api/integrations/github-app/repositories')
  .set('x-test-user', String(user._id)).send(body);

const adminConnect = (body, as = admin) => request(app).post('/api/integrations/github-app')
  .set('x-test-user', String(as._id)).send(body);

const ENV_KEYS = ['GITHUB_CONNECT_APP_ID', 'GITHUB_CONNECT_APP_PRIVATE_KEY'];
const savedEnv = {};

jest.setTimeout(60000);
beforeAll(async () => {
  await setupMongoDb();
  await Integration.syncIndexes();
  ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });
  app = express();
  app.use(express.json());
  app.use('/api/integrations', require('../../routes/integrations'));
});
afterAll(async () => {
  ENV_KEYS.forEach((k) => { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; });
  await closeMongoDb();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockGithub.requests.length = 0;
  process.env.GITHUB_CONNECT_APP_ID = CONNECT_APP_ID;
  process.env.GITHUB_CONNECT_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
    modulusLength: 1024, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  await Promise.all([User.deleteMany({}), Integration.deleteMany({}), RoomGrant.deleteMany({})]);
  alice = await User.create({ username: 'alice', email: 'alice@example.test', password: 'pw-123456' });
  bob = await User.create({ username: 'bob', email: 'bob@example.test', password: 'pw-123456' });
  admin = await User.create({
    username: 'root', email: 'root@example.test', password: 'pw-123456', role: 'admin', 
  });
  bot = await User.create({
    username: 'a-bot',
    email: 'bot@agents.commonly.local',
    password: 'pw-123456',
    isBot: true,
    botType: 'agent',
    botMetadata: { agentName: 'helper', instanceId: 'default' }, 
  });
  mockGithub.byToken = {
    'alice-user-token': {
      installations: [
        { id: Number(INSTALL), app_id: Number(CONNECT_APP_ID), suspended_at: null },
        // An installation of some other App the same person can see.
        { id: Number(OTHER_INSTALL), app_id: 999, suspended_at: null },
      ],
      repositories: {
        [INSTALL]: [repo('Outside-Team/Widget'), repo('Outside-Team/Gadget'),
          repo('Outside-Team/ReadOnly', { push: false, pull: true })],
        [OTHER_INSTALL]: [repo('Outside-Team/Elsewhere')],
      },
    },
    'bob-user-token': {
      installations: [{ id: Number(INSTALL), app_id: Number(CONNECT_APP_ID), suspended_at: null }],
      repositories: { [INSTALL]: [repo('Outside-Team/Widget'), repo('Outside-Team/Gadget')] },
    },
  };
});

describe('self-serve Commonly Connect repository connection', () => {
  test('creates the connection, owned by the caller, only when their token lists the installation and the repository', async () => {
    await giveUserToken(alice, 'alice-user-token');
    const res = await connectRepo(alice, { installationId: INSTALL, owner: 'outside-team', repo: 'widget' });
    expect(res.status).toBe(201);
    const row = await Integration.findById(res.body.integration._id).lean();
    expect(row).toMatchObject({ type: 'github-app', status: 'connected', scope: 'user' });
    expect(String(row.createdBy)).toBe(String(alice._id));
    // GitHub's spelling, not the body's; the App is the server's word.
    expect(row.config).toMatchObject({
      app: 'connect', installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget', repoKey: 'outside-team/widget', 
    });
    // Per-repository rows never take the one-row-per-installation slot.
    expect(row.installationId).toBeUndefined();
    // The proof was read with Alice's own token.
    expect(mockGithub.requests.map((r) => r.token)).toEqual(expect.arrayContaining(['alice-user-token']));
    expect(new Set(mockGithub.requests.map((r) => r.token))).toEqual(new Set(['alice-user-token']));
  });

  test('a forged installationId the caller cannot see is refused and nothing is created', async () => {
    await giveUserToken(alice, 'alice-user-token');
    const res = await connectRepo(alice, { installationId: '7999', owner: 'Outside-Team', repo: 'Widget' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('installation_not_visible');
    expect(await Integration.countDocuments({ type: 'github-app' })).toBe(0);
  });

  test('an installation of another App is refused, even when the caller can see it', async () => {
    await giveUserToken(alice, 'alice-user-token');
    const res = await connectRepo(alice, { installationId: OTHER_INSTALL, owner: 'Outside-Team', repo: 'Elsewhere' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('installation_not_visible');
    expect(await Integration.countDocuments({ type: 'github-app' })).toBe(0);
  });

  test('a forged repository outside the installation is refused', async () => {
    await giveUserToken(alice, 'alice-user-token');
    const res = await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Elsewhere' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('repository_not_visible');
    const other = await connectRepo(alice, { installationId: INSTALL, owner: 'Someone-Else', repo: 'Widget' });
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('repository_not_visible');
    expect(await Integration.countDocuments({ type: 'github-app' })).toBe(0);
  });

  test('a repository the caller can only read is refused', async () => {
    await giveUserToken(alice, 'alice-user-token');
    const res = await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'ReadOnly' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('repository_write_required');
    expect(await Integration.countDocuments({ type: 'github-app' })).toBe(0);
  });

  test('with no GitHub user token it refuses and points at the connect flow, without calling GitHub', async () => {
    const res = await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'github_connect_required', connect: '/api/integrations/connect/hosted-mcp/github-mcp/start' });
    expect(hostedVendorFetch).not.toHaveBeenCalled();
    expect(await Integration.countDocuments({ type: 'github-app' })).toBe(0);
  });

  test('another person\'s GitHub token is never used for the caller', async () => {
    await giveUserToken(bob, 'bob-user-token');
    const res = await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('github_connect_required');
    expect(hostedVendorFetch).not.toHaveBeenCalled();
  });

  test('a disconnected GitHub token row does not count', async () => {
    const row = await giveUserToken(alice, 'alice-user-token');
    await Integration.updateOne({ _id: row._id }, { $set: { status: 'disconnected' } });
    const res = await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget' });
    expect(res.body.error).toBe('github_connect_required');
  });

  test('an expired user token (GitHub 401) asks to connect again', async () => {
    await giveUserToken(alice, 'stale-token');
    const res = await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('github_connect_required');
  });

  test('refuses github_app_not_configured when the Connect key is absent, before any GitHub call', async () => {
    delete process.env.GITHUB_CONNECT_APP_PRIVATE_KEY;
    await giveUserToken(alice, 'alice-user-token');
    const res = await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('github_app_not_configured');
    expect(hostedVendorFetch).not.toHaveBeenCalled();
  });

  test('malformed bodies are refused before any lookup', async () => {
    await giveUserToken(alice, 'alice-user-token');
    for (const body of [{}, { installationId: 'abc', owner: 'o', repo: 'r' }, { installationId: INSTALL, owner: ['o'], repo: 'r' },
      { installationId: INSTALL, owner: 'o', repo: '../x' }]) {
      const res = await connectRepo(alice, body);
      expect(res.status).toBe(400);
    }
    expect(hostedVendorFetch).not.toHaveBeenCalled();
  });

  test('a second repository on the same installation succeeds; the same repository twice is 409', async () => {
    await giveUserToken(alice, 'alice-user-token');
    await giveUserToken(bob, 'bob-user-token');
    const first = await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget' });
    expect(first.status).toBe(201);
    const second = await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Gadget' });
    expect(second.status).toBe(201);
    const again = await connectRepo(alice, { installationId: INSTALL, owner: 'outside-team', repo: 'WIDGET' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'connection_exists', integrationId: first.body.integration._id });
    // Someone else learns it is taken, not which row it is.
    const bobs = await connectRepo(bob, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget' });
    expect(bobs.status).toBe(409);
    expect(bobs.body.integrationId).toBeUndefined();
    expect(await Integration.countDocuments({ type: 'github-app' })).toBe(2);
  });

  test('the database index refuses a duplicate repository the route did not catch', async () => {
    const row = {
      type: 'github-app',
      scope: 'user',
      status: 'connected',
      createdBy: alice._id,
      isActive: true,
      config: {
        app: 'connect', installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget', repoKey: 'outside-team/widget', 
      }, 
    };
    await Integration.create(row);
    await expect(Integration.create(row)).rejects.toMatchObject({ code: 11000 });
    // Same repository on the other App is a different connection.
    await expect(Integration.create({ ...row, config: { ...row.config, app: 'tools' } })).resolves.toBeTruthy();
  });

  test('another user cannot see or delete the connection; its owner can, and only its own grants end', async () => {
    await giveUserToken(alice, 'alice-user-token');
    const widget = (await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Widget' })).body.integration;
    const gadget = (await connectRepo(alice, { installationId: INSTALL, owner: 'Outside-Team', repo: 'Gadget' })).body.integration;
    const grantOn = (row) => createGrant({
      connectionId: String(row._id),
      connectionRowId: String(row._id),
      installationId: INSTALL,
      target: { kind: 'pod', id: '6a8f6de2a1dccf2e02f31499' },
      tools: ['github.get_issue'],
      writeMode: 'read',
      audience: [String(bot._id)],
      expiresAt: new Date(Date.now() + 86400000),
      brokerId: GRANT_BROKER_ID,
      ownerId: String(alice._id),
    });
    const widgetGrant = await grantOn(widget);
    const gadgetGrant = await grantOn(gadget);

    const bobsList = await request(app).get('/api/integrations/user/all').set('x-test-user', String(bob._id));
    expect(bobsList.status).toBe(200);
    expect(bobsList.body.map((row) => String(row._id))).not.toContain(String(widget._id));
    const alicesList = await request(app).get('/api/integrations/user/all').set('x-test-user', String(alice._id));
    expect(alicesList.body.map((row) => String(row._id))).toEqual(expect.arrayContaining([String(widget._id), String(gadget._id)]));

    const bobDelete = await request(app).delete(`/api/integrations/${widget._id}`).set('x-test-user', String(bob._id));
    expect(bobDelete.status).toBe(403);
    expect(await Integration.findById(widget._id)).not.toBeNull();

    const aliceDelete = await request(app).delete(`/api/integrations/${widget._id}`).set('x-test-user', String(alice._id));
    expect(aliceDelete.status).toBe(200);
    expect(await Integration.findById(widget._id)).toBeNull();
    expect((await RoomGrant.findOne({ grantId: widgetGrant.grantId }).lean()).revokedAt).toBeTruthy();
    // The sibling repository shares the installation id, and keeps its grant.
    expect((await RoomGrant.findOne({ grantId: gadgetGrant.grantId }).lean()).revokedAt).toBeFalsy();
  });
});

describe('administrator route: per-repository uniqueness and a named owner', () => {
  test('a second repository on the same installation succeeds; the same repository twice is 409', async () => {
    const first = await adminConnect({ installationId: '501', owner: 'Team-Commonly', repo: 'commonly' });
    expect(first.status).toBe(201);
    expect(first.body.integration.config).toMatchObject({ app: 'tools', installationId: '501', repoKey: 'team-commonly/commonly' });
    expect(String(first.body.integration.createdBy)).toBe(String(admin._id));
    const second = await adminConnect({ installationId: '501', owner: 'Team-Commonly', repo: 'commonly-gtm' });
    expect(second.status).toBe(201);
    const again = await adminConnect({ installationId: '501', owner: 'team-commonly', repo: 'COMMONLY' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('connection_exists');
    expect(await Integration.countDocuments({ type: 'github-app' })).toBe(2);
  });

  test('a legacy row (top-level installationId, no app) still blocks its own repository, not a sibling', async () => {
    await Integration.create({
      type: 'github-app',
      scope: 'user',
      status: 'connected',
      createdBy: admin._id,
      isActive: true,
      installationId: '502',
      config: { installationId: '502', owner: 'Team-Commonly', repo: 'commonly' }, 
    });
    expect((await adminConnect({ installationId: '502', owner: 'Team-Commonly', repo: 'commonly' })).status).toBe(409);
    expect((await adminConnect({ installationId: '502', owner: 'Team-Commonly', repo: 'other' })).status).toBe(201);
  });

  test('ownerUserId names an existing human; a bot, a missing user or a malformed id is refused', async () => {
    const named = await adminConnect({
      installationId: '503', owner: 'Team-Commonly', repo: 'a', ownerUserId: String(alice._id), 
    });
    expect(named.status).toBe(201);
    expect(String(named.body.integration.createdBy)).toBe(String(alice._id));
    for (const ownerUserId of [String(bot._id), '6a8f6de2a1dccf2e02f31400', 'not-an-id', '']) {
      const res = await adminConnect({
        installationId: '503', owner: 'Team-Commonly', repo: `b-${ownerUserId.length}`, ownerUserId, 
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_owner');
    }
    await User.updateOne({ _id: bob._id }, { $set: { banned: true } });
    const banned = await adminConnect({
      installationId: '503', owner: 'Team-Commonly', repo: 'c', ownerUserId: String(bob._id), 
    });
    expect(banned.status).toBe(400);
  });

  test('the administrator route cannot write a Connect row, and a non-admin cannot use it', async () => {
    const connect = await adminConnect({
      installationId: '504', owner: 'o', repo: 'r', app: 'connect', 
    });
    expect(connect.status).toBe(400);
    const member = await adminConnect({ installationId: '504', owner: 'o', repo: 'r' }, alice);
    expect(member.status).toBe(403);
    expect(await Integration.countDocuments({ type: 'github-app' })).toBe(0);
  });

  test('the generic connector route still refuses github-app, whatever config.app says', async () => {
    const res = await request(app).post('/api/integrations').set('x-test-user', String(alice._id))
      .send({
        podId: '6a8f6de2a1dccf2e02f31499',
        type: 'github-app',
        config: {
          app: 'connect', installationId: INSTALL, owner: 'o', repo: 'r', 
        }, 
      });
    expect(res.status).toBe(400);
    expect(await Integration.countDocuments({ type: 'github-app' })).toBe(0);
  });
});
