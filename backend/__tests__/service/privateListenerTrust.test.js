const express = require('express');
const rateLimit = require('express-rate-limit');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

const mockOwner = { id: new mongoose.Types.ObjectId().toString() };
jest.mock('../../middleware/auth', () => {
  const auth = (req, _res, next) => { req.userId = mockOwner.id; req.user = { id: mockOwner.id }; next(); };
  auth.touchLastActive = () => {};
  return auth;
});
jest.mock('../../services/starterTaskService', () => ({ completeConnectAgentStarterTask: jest.fn() }));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Integration = require('../../models/Integration');
const AgentCredential = require('../../models/AgentCredential');
const { AgentInstallation, AgentRegistry } = require('../../models/AgentRegistry');
const agentRuntimeAuth = require('../../middleware/agentRuntimeAuth');
const { hash } = require('../../utils/secret');
const { privateListenerPodAllowed } = require('../../services/privateListenerPolicy');

const app = express();
app.use(express.json());
app.use('/api/registry', require('../../routes/registry/install'));
app.use('/api/registry', require('../../routes/registry/agent-config'));
app.use('/api/registry', require('../../routes/registry/agent-tokens'));
app.use('/api/agent-binding', require('../../routes/agentBinding'));
app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
app.get('/probe', rateLimit({ windowMs: 60000, max: 10000 }), agentRuntimeAuth,
  (_req, res) => res.json({ ok: true }));

const AGENT = 'private-listener-test';
const DAEMON = `cm_daemon_${'a'.repeat(32)}`;
let pod; let bot;

const issue = () => request(app)
  .post(`/api/registry/pods/${pod._id}/agents/${AGENT}/runtime-tokens`)
  .send({ label: 'private listener' });
const assigned = () => request(app).get('/api/agent-binding/assigned')
  .set('Authorization', `Bearer ${DAEMON}`);
const install = (agentName, path = '~/projects/example', targetPod = pod) => request(app).post('/api/registry/install').send({
  agentName, podId: String(targetPod._id), scopes: ['context:read'],
  config: { runtime: { runtimeType: 'webhook' }, environment: {
    workspace: { path }, sandbox: { trust: 'private' },
  } },
});

beforeAll(async () => { await setupMongoDb(); });
afterAll(async () => { await closeMongoDb(); });
beforeEach(async () => {
  await clearMongoDb();
  await User.create({ _id: mockOwner.id, username: 'private-owner', email: 'private-owner@test.com', password: 'password123' });
  bot = await User.create({
    username: AGENT, email: `${AGENT}@agents.commonly.local`, password: 'password123',
    isBot: true, botMetadata: { agentName: AGENT, instanceId: 'default', machineId: 'private-machine' },
  });
  pod = await Pod.create({
    name: 'Sole owner', type: 'chat', joinPolicy: 'invite-only',
    createdBy: mockOwner.id, members: [mockOwner.id, bot._id],
  });
  await AgentInstallation.create({
    agentName: AGENT, instanceId: 'default', podId: pod._id,
    installedBy: mockOwner.id, status: 'active', version: '1.0.0',
    config: { runtime: { runtimeType: 'webhook' }, environment: {
      workspace: { path: '~/projects/example' }, sandbox: { trust: 'private' },
    } },
  });
  await AgentCredential.create({
    tokenHash: hash(DAEMON), kind: 'daemon', ownerUserId: mockOwner.id,
    machineId: 'private-machine', scopes: ['agents:adopt'],
  });
});

test('a query-shaped pod id cannot broaden private-listener eligibility', async () => {
  expect(await privateListenerPodAllowed({ $ne: null }, mockOwner.id)).toBe(false);
  expect(await privateListenerPodAllowed(String(pod._id), mockOwner.id)).toBe(true);
});

test('sole owner can issue; runtime bootstrap receives only the selected path and trust', async () => {
  const minted = await issue();
  expect(minted.status).toBe(200);
  expect(minted.body.token).toMatch(/^cm_agent_/);
  const installations = await request(app).get('/api/agents/runtime/installations')
    .set('Authorization', `Bearer ${minted.body.token}`);
  expect(installations.status).toBe(200);
  expect(installations.body.installations[0].listenerEnvironment).toEqual({
    workspace: { path: '~/projects/example' }, sandbox: { trust: 'private' },
  });
  expect(installations.body.installations[0]).not.toHaveProperty('config');
  expect((await assigned()).body.agents).toHaveLength(1);
});

test('second human pauses existing token and daemon assignment; new issuance is refused without rotation', async () => {
  const minted = await issue();
  expect(minted.status).toBe(200);
  const second = await User.create({ username: 'second', email: 'second@test.com', password: 'password123' });
  await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: second._id } });
  expect((await request(app).get('/probe').set('Authorization', `Bearer ${minted.body.token}`)).status).toBe(403);
  expect((await assigned()).body.agents).toEqual([]);
  const refused = await issue();
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('private_listener_not_allowed');
  expect(await User.countDocuments({ 'agentRuntimeTokens.tokenHash': hash(minted.body.token) })).toBe(1);
});

test('a live group bridge pauses a private listener and refuses new issuance', async () => {
  const minted = await issue();
  expect(minted.status).toBe(200);
  await Integration.create({
    podId: pod._id, scope: 'pod', type: 'slack', status: 'connected', isActive: true,
    createdBy: mockOwner.id, config: {},
  });
  expect((await request(app).get('/probe').set('Authorization', `Bearer ${minted.body.token}`)).status).toBe(403);
  expect((await assigned()).body.agents).toEqual([]);
  const refused = await issue();
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('private_listener_not_allowed');
});

test('second human also pauses an older installation-bound runtime token', async () => {
  const legacy = `cm_agent_${'b'.repeat(32)}`;
  await AgentInstallation.updateOne({ agentName: AGENT }, {
    $push: { runtimeTokens: { tokenHash: hash(legacy), createdAt: new Date() } },
  });
  expect((await request(app).get('/probe').set('Authorization', `Bearer ${legacy}`)).status).toBe(200);
  const second = await User.create({ username: 'legacy-second', email: 'legacy-second@test.com', password: 'password123' });
  await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: second._id } });
  expect((await request(app).get('/probe').set('Authorization', `Bearer ${legacy}`)).status).toBe(403);
});

test.each([
  ['open pod', { joinPolicy: 'open' }],
  ['public pod', { publicRead: true }],
])('%s cannot issue a private listener token', async (_label, change) => {
  await Pod.updateOne({ _id: pod._id }, { $set: change });
  const refused = await issue();
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('private_listener_not_allowed');
  expect(await User.countDocuments({ 'agentRuntimeTokens.0': { $exists: true } })).toBe(0);
});

test('install refuses private trust in a shared pod before creating a registry identity', async () => {
  const second = await User.create({ username: 'install-second', email: 'install-second@test.com', password: 'password123' });
  await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: second._id } });
  const refused = await install('private-install-refused');
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('private_listener_not_allowed');
  expect(await AgentRegistry.findOne({ agentName: 'private-install-refused' })).toBeNull();
});

test('sole owner can install the private listener with the selected repo path', async () => {
  const created = await install('private-install-allowed');
  expect(created.status).toBe(200);
  const row = await AgentInstallation.findOne({ agentName: 'private-install-allowed' });
  expect(row.config.get('environment')).toEqual({
    workspace: { path: '~/projects/example' }, sandbox: { trust: 'private' },
  });
});

test('relative repo paths are refused before creating an agent', async () => {
  const refused = await install('private-relative-path', '../another-repo');
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('private_listener_not_allowed');
  expect(await AgentRegistry.findOne({ agentName: 'private-relative-path' })).toBeNull();
});

test('a newer private install cannot be shadowed by an older read-only installation', async () => {
  const first = await request(app).post('/api/registry/install').send({
    agentName: 'mixed-trust-agent', podId: String(pod._id), scopes: ['context:read'],
    config: { runtime: { runtimeType: 'webhook' } },
  });
  expect(first.status).toBe(200);
  const peerPod = await Pod.create({ name: 'Second owned pod', type: 'chat', joinPolicy: 'invite-only',
    createdBy: mockOwner.id, members: [mockOwner.id] });
  const refused = await install('mixed-trust-agent', '~/projects/example', peerPod);
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('private_listener_not_allowed');
  expect(await AgentInstallation.countDocuments({ agentName: 'mixed-trust-agent' })).toBe(1);
});

test('a read-only choice cannot inherit private trust from an older installation', async () => {
  expect((await install('private-then-public')).status).toBe(200);
  const peerPod = await Pod.create({ name: 'Read-only peer pod', type: 'chat', joinPolicy: 'invite-only',
    createdBy: mockOwner.id, members: [mockOwner.id] });
  const refused = await request(app).post('/api/registry/install').send({
    agentName: 'private-then-public', podId: String(peerPod._id), scopes: ['context:read'],
    config: { runtime: { runtimeType: 'webhook' } },
  });
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('private_listener_requires_downgrade');
  expect(await AgentInstallation.countDocuments({ agentName: 'private-then-public' })).toBe(1);
});

test('a config edit cannot renew private trust after another human joins', async () => {
  const second = await User.create({ username: 'config-second', email: 'config-second@test.com', password: 'password123' });
  await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: second._id } });
  const refused = await request(app).patch(`/api/registry/pods/${pod._id}/agents/${AGENT}`).send({
    config: { environment: { workspace: { path: '~/projects/changed' }, sandbox: { trust: 'private' } } },
  });
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('private_listener_not_allowed');
  const row = await AgentInstallation.findOne({ agentName: AGENT });
  expect(row.config.get('environment').workspace.path).toBe('~/projects/example');
});

test('owner can promote a read-only listener in a sole-human invite pod', async () => {
  await AgentInstallation.updateOne({ agentName: AGENT }, {
    $set: { 'config.environment': { sandbox: { trust: 'public' } } },
  });
  const changed = await request(app).patch(`/api/registry/pods/${pod._id}/agents/${AGENT}`).send({
    config: { environment: { workspace: { path: '~/projects/promoted' }, sandbox: { trust: 'private' } } },
  });
  expect(changed.status).toBe(200);
  const row = await AgentInstallation.findOne({ agentName: AGENT });
  expect(row.config.get('environment').workspace.path).toBe('~/projects/promoted');
});

test('owner can downgrade to read-only after a second human joins', async () => {
  const old = await issue();
  expect(old.status).toBe(200);
  const retainedMcp = [{ name: 'existing', transport: 'http', url: 'https://example.com/mcp' }];
  const existing = await AgentInstallation.findOne({ agentName: AGENT });
  existing.config.set('environment', { ...existing.config.get('environment'), mcp: retainedMcp });
  await existing.save();
  const legacy = `cm_agent_${'c'.repeat(32)}`;
  await AgentInstallation.updateOne({ agentName: AGENT }, {
    $push: { runtimeTokens: { tokenHash: hash(legacy), createdAt: new Date() } },
  });
  const second = await User.create({ username: 'downgrade-second', email: 'downgrade-second@test.com', password: 'password123' });
  await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: second._id } });
  const changed = await request(app).patch(`/api/registry/pods/${pod._id}/agents/${AGENT}`).send({
    config: { environment: { sandbox: { trust: 'public' } } },
  });
  expect(changed.status).toBe(200);
  // The same running CLI still has a private environment in memory. Its old
  // bearer must stay dead even though the server config is now read-only.
  expect((await request(app).get('/probe').set('Authorization', `Bearer ${old.body.token}`)).status).toBe(401);
  expect((await request(app).get('/probe').set('Authorization', `Bearer ${legacy}`)).status).toBe(401);
  expect(await User.countDocuments({ 'agentRuntimeTokens.tokenHash': hash(old.body.token) })).toBe(0);
  expect((await issue()).status).toBe(200);
  expect((await assigned()).body.agents[0].environment.sandbox.trust).toBe('public');
  const row = await AgentInstallation.findOne({ agentName: AGENT });
  expect(row.config.get('environment')).toEqual({ sandbox: { trust: 'public' }, mcp: retainedMcp });
});
