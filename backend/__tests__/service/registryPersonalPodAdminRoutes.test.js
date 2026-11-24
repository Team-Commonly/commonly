const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentCredential = require('../../models/AgentCredential');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { issueRuntimeTokenForAgent } = require('../../routes/registry/tokens');

// F613: the F612 rule (an agent-room or agent-admin pod is private to its
// members, admins included) on every other registry route that acts on one
// installed agent: the token routes, uninstall, the single-agent read, the
// config PATCH and the per-pod settings writes. On a team or chat pod an
// admin who is not a member keeps the access each route gave admins before.
// Real routers and real models; nothing here calls out of the process.
const SECRET = 'registry-personal-pod-admin-routes-test';
const AGENT = 'codex';
const INSTANCE = 'curator';
const SCHEDULE = { enabled: true, time: '07:47', timezone: 'America/Los_Angeles', prompt: 'Post the count.' };

// [label, method, path, request data, refusal error (undefined: only the status is pinned)]
const operations = [
  ['list runtime tokens', 'get', (f, podId) => `/api/registry/pods/${podId}/agents/${AGENT}/runtime-tokens`,
    () => ({ instanceId: INSTANCE }), 'Access denied'],
  ['mint a runtime token', 'post', (f, podId) => `/api/registry/pods/${podId}/agents/${AGENT}/runtime-tokens`,
    () => ({ instanceId: INSTANCE, label: 'minted' }), 'Access denied'],
  ['revoke a runtime token', 'delete',
    (f, podId) => `/api/registry/pods/${podId}/agents/${AGENT}/runtime-tokens/${f.tokenId}`,
    () => ({ instanceId: INSTANCE }), 'Access denied'],
  ['clear the unsandboxed mark', 'delete', (f, podId) => `/api/registry/pods/${podId}/agents/${AGENT}/host-unconfined`,
    () => ({ instanceId: INSTANCE }), 'Access denied'],
  ['revoke every token', 'delete', (f, podId) => `/api/registry/pods/${podId}/agents/${AGENT}/tokens`,
    () => ({ instanceId: INSTANCE }), 'Access denied'],
  ['uninstall', 'delete', (f, podId) => `/api/registry/agents/${AGENT}/pods/${podId}`,
    () => ({ instanceId: INSTANCE }), 'Access denied'],
  ['read the installed agent', 'get', (f, podId) => `/api/registry/pods/${podId}/agents/${AGENT}`,
    () => ({ instanceId: INSTANCE }), 'Access denied'],
  ['change its config', 'patch', (f, podId) => `/api/registry/pods/${podId}/agents/${AGENT}`,
    () => ({ instanceId: INSTANCE, config: { runtime: { adapter: 'claude' } } }), 'Access denied'],
  ['change its wake settings', 'patch',
    (f, podId) => `/api/registry/agents/${AGENT}/manage-settings/pods/${podId}?instanceId=${INSTANCE}`,
    () => ({ wakeOnMessage: false, humanOnly: false, boardWake: true, heartbeatEnabled: false }),
    'Installer or admin required'],
  ['stop its schedule', 'put',
    (f, podId) => `/api/registry/agents/${AGENT}/manage-settings/pods/${podId}/schedule?instanceId=${INSTANCE}`,
    () => ({ enabled: false }), undefined],
];

describe('an admin acts on an agent in a personal pod only as a member, on every per-agent route', () => {
  let app;
  let nonce = 0;
  const f = {};

  const call = (method, path, user, data) => {
    nonce += 1;
    const req = request(app)[method](path)
      .set('Authorization', `Bearer ${jwt.sign({ id: String(user._id), n: nonce }, SECRET)}`)
      .set('cf-connecting-ip', `203.0.113.${nonce % 250}`);
    return method === 'get' || method === 'delete' ? req.query(data) : req.send(data);
  };
  const run = ([, method, path, data], user, podKey) => call(method, path(f, f.pods[podKey]._id), user, data());

  // Everything an allowed call could touch: every installation row, the agent
  // user's tokens and marks, and the credential ledger.
  const snapshot = async () => {
    const [rows, agentUser, credentials] = await Promise.all([
      AgentInstallation.find({}).sort({ _id: 1 }).lean(),
      User.findById(f.agentUser._id).select('+apiTokenHash').lean(),
      AgentCredential.find({}).sort({ _id: 1 }).lean(),
    ]);
    return JSON.stringify({
      rows: rows.map(({ updatedAt, ...row }) => row),
      tokens: agentUser.agentRuntimeTokens,
      apiTokenHash: agentUser.apiTokenHash || null,
      hostUnconfined: agentUser.botMetadata?.hostUnconfined || null,
      credentials: credentials.map(({ updatedAt, ...row }) => row),
    });
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', require('../../routes/registry/agent-tokens'));
    app.use('/api/registry', require('../../routes/registry/pod-agents'));
    app.use('/api/registry', require('../../routes/registry/agent-config'));
    app.use('/api/registry', require('../../routes/registry/manage-settings'));
  });

  beforeEach(async () => {
    await clearMongoDb();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    [f.installer, f.admin, f.member] = await Promise.all(['installer', 'admin', 'member'].map((name) => User.create({
      username: `routes-${name}`,
      email: `routes-${name}@example.test`,
      password: 'test-password',
      role: name === 'admin' ? 'admin' : 'user',
    })));
    f.agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: INSTANCE });
    await User.updateOne({ _id: f.agentUser._id }, { $set: { 'botMetadata.hostUnconfined': true } });
    f.pods = {};
    const specs = [['agentRoom', 'agent-room'], ['agentAdmin', 'agent-admin'], ['team', 'team'], ['chat', 'chat']];
    for (const [key, type] of specs) {
      // eslint-disable-next-line no-await-in-loop
      f.pods[key] = await Pod.create({
        name: `Routes ${type}`, type, createdBy: f.installer._id, members: [f.installer._id, f.agentUser._id],
      });
      // eslint-disable-next-line no-await-in-loop
      await AgentInstallation.create({
        agentName: AGENT, instanceId: INSTANCE, podId: f.pods[key]._id, version: '1', installedBy: f.installer._id,
        status: 'active',
        config: new Map([['runtime', { runtimeType: 'local-cli', host: 'byo' }], ['schedule', SCHEDULE]]),
      });
    }
    const installation = await AgentInstallation.findOne({ podId: f.pods.agentRoom._id });
    await issueRuntimeTokenForAgent(f.agentUser, 'seed', installation, { ownerUserId: f.installer._id });
    const seeded = await User.findById(f.agentUser._id).lean();
    f.tokenId = String(seeded.agentRuntimeTokens[0]._id);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  describe.each(operations)('%s', (...operation) => {
    const refusalError = operation[4];

    it.each(['agentRoom', 'agentAdmin'])('refuses an admin who is not a member of the %s pod, changing nothing', async (key) => {
      const before = await snapshot();
      const res = await run(operation, f.admin, key);
      expect(res.status).toBe(403);
      if (refusalError) expect(res.body.error).toBe(refusalError);
      expect(await snapshot()).toBe(before);
    });

    it('lets the same admin through once a member of the agent-room', async () => {
      await Pod.updateOne({ _id: f.pods.agentRoom._id }, { $addToSet: { members: f.admin._id } });
      const res = await run(operation, f.admin, 'agentRoom');
      expect(res.status).toBe(200);
    });

    it.each(['team', 'chat'])('still lets an admin who is not a member of a %s pod through', async (key) => {
      const res = await run(operation, f.admin, key);
      expect(res.status).toBe(200);
    });

    it('still lets the installer act on the agent-room agent', async () => {
      const res = await run(operation, f.installer, 'agentRoom');
      expect(res.status).toBe(200);
    });
  });

  describe('the config PATCH fan-out', () => {
    const adapterIn = async (key) => {
      const row = await AgentInstallation.findOne({ podId: f.pods[key]._id }).lean();
      const config = row.config instanceof Map ? Object.fromEntries(row.config) : row.config;
      return config.runtime?.adapter;
    };

    it('carries an admin\'s change to the agent\'s other team pods but not into a personal pod they are not in', async () => {
      const res = await call('patch', `/api/registry/pods/${f.pods.team._id}/agents/${AGENT}`, f.admin,
        { instanceId: INSTANCE, config: { runtime: { adapter: 'claude' } } });
      expect(res.status).toBe(200);
      expect(await adapterIn('team')).toBe('claude');
      expect(await adapterIn('chat')).toBe('claude');
      expect(await adapterIn('agentRoom')).toBeUndefined();
      expect(await adapterIn('agentAdmin')).toBeUndefined();
    });

    it('carries it into the personal pod the admin is a member of', async () => {
      await Pod.updateOne({ _id: f.pods.agentRoom._id }, { $addToSet: { members: f.admin._id } });
      const res = await call('patch', `/api/registry/pods/${f.pods.team._id}/agents/${AGENT}`, f.admin,
        { instanceId: INSTANCE, config: { runtime: { adapter: 'claude' } } });
      expect(res.status).toBe(200);
      expect(await adapterIn('agentRoom')).toBe('claude');
      expect(await adapterIn('agentAdmin')).toBeUndefined();
    });
  });

  describe('an admin renaming the agent from a team pod', () => {
    const rename = () => call('patch', `/api/registry/pods/${f.pods.team._id}/agents/${AGENT}`, f.admin,
      { instanceId: INSTANCE, displayName: 'Renamed Curator' });
    const names = async () => {
      const [rows, agentUser] = await Promise.all([
        AgentInstallation.find({}).sort({ _id: 1 }).lean(),
        User.findById(f.agentUser._id).lean(),
      ]);
      return { rows: rows.map((row) => row.displayName || null), user: agentUser.botMetadata?.displayName || null };
    };

    it('is refused while the agent is also in an agent-admin pod the admin is not in, renaming nothing', async () => {
      const before = await names();
      const res = await rename();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('identity_rename_scope_incomplete');
      expect(await names()).toEqual(before);
      expect(before.rows).not.toContain('Renamed Curator');
    });

    it('goes through once the admin is a member of that agent-admin pod', async () => {
      await Pod.updateOne({ _id: f.pods.agentAdmin._id }, { $addToSet: { members: f.admin._id } });
      const res = await rename();
      expect(res.status).toBe(200);
      const row = await AgentInstallation.findOne({ podId: f.pods.agentAdmin._id }).lean();
      expect(row.displayName).toBe('Renamed Curator');
    });
  });

  describe('the user-token metadata read', () => {
    const read = (user, key) => call('get', `/api/registry/pods/${f.pods[key]._id}/agents/${AGENT}/user-token`,
      user, { instanceId: INSTANCE });

    it('answers the installer and an admin who is a member', async () => {
      expect((await read(f.installer, 'agentRoom')).status).toBe(200);
      await Pod.updateOne({ _id: f.pods.team._id }, { $addToSet: { members: f.admin._id } });
      expect((await read(f.admin, 'team')).status).toBe(200);
    });

    it('refuses a member who did not install the agent, as its sibling routes do', async () => {
      await Pod.updateOne({ _id: f.pods.team._id }, { $addToSet: { members: f.member._id } });
      const res = await read(f.member, 'team');
      expect(res.status).toBe(403);
      expect(res.body.hasToken).toBeUndefined();
    });

    it('refuses the pod\'s creator when someone else installed the agent', async () => {
      const pod = await Pod.create({
        name: 'Created by the member', type: 'team', createdBy: f.member._id,
        members: [f.member._id, f.installer._id, f.agentUser._id],
      });
      await AgentInstallation.create({
        agentName: AGENT, instanceId: INSTANCE, podId: pod._id, version: '1', installedBy: f.installer._id,
        status: 'active', config: new Map([['runtime', { runtimeType: 'local-cli', host: 'byo' }]]),
      });
      const res = await call('get', `/api/registry/pods/${pod._id}/agents/${AGENT}/user-token`,
        f.member, { instanceId: INSTANCE });
      expect(res.status).toBe(403);
      expect(res.body.hasToken).toBeUndefined();
    });
  });
});
