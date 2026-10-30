/* eslint-disable import/no-unresolved, import/extensions */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const catalogRoutes = require('../../routes/registry/catalog');
const { proposeAction } = require('../../services/approvalActionService');
const ApprovalAction = require('../../models/ApprovalAction');

const JWT_SECRET = 'test-jwt-secret-byo-next-name';

describe('BYO next-free-name lookup', () => {
  let app;
  let owner;
  let other;
  let token;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use('/api/registry', catalogRoutes);
    owner = await User.create({ username: 'name-owner', email: 'name-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'name-other', email: 'name-other@test.com', password: 'password123' });
    token = jwt.sign({ id: String(owner._id) }, JWT_SECRET);
  });

  afterAll(async () => { await closeMongoDb(); });

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    await Pod.deleteMany({});
    await User.deleteMany({ isBot: true });
  });

  const pod = async (name, memberIds, publicRead = false) => Pod.create({
    name, type: 'chat', createdBy: memberIds[0], members: memberIds, publicRead,
  });
  const install = (target, name, installedBy = owner._id, status = 'active') => AgentInstallation.create({
    podId: target._id, agentName: name, instanceId: 'default', version: '1.0.0', installedBy, status,
  });

  it('uses active names in the caller’s private member pods and skips other scopes', async () => {
    const first = await pod('one', [owner._id]);
    const second = await pod('two', [other._id, owner._id]);
    const publicPod = await pod('public', [owner._id], true);
    const unrelated = await pod('unrelated', [other._id]);
    await Promise.all([
      install(first, 'sam-claude'),
      install(second, 'sam-claude-2', other._id),
      install(publicPod, 'sam-claude-3'),
      install(unrelated, 'sam-claude-3', other._id),
      install(first, 'sam-claude-3', owner._id, 'uninstalled'),
    ]);

    const response = await request(app)
      .get('/api/registry/agents/next-free-name?base=sam-claude')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ name: 'sam-claude-3' });
  });

  it('the connect card proposes the same free name the connect page would land on (TASK-329)', async () => {
    const here = await pod('here', [owner._id]);
    const elsewhere = await pod('elsewhere', [owner._id]);
    await Promise.all([
      install(elsewhere, 'sam-claude'),
      install(elsewhere, 'sam-claude-2'),
    ]);

    const result = await proposeAction({
      podId: String(here._id),
      agentName: 'scout',
      instanceId: 'default',
      displayName: 'Scout',
      actionType: 'connect_local_agent',
      params: { name: 'sam-claude', adapter: 'claude' },
      summary: "Connect your own agent as 'sam-claude'",
      ownerUserId: owner._id,
    });
    expect(result.ok).toBe(true);
    const row = await ApprovalAction.findById(result.approvalId).lean();
    expect(row.params).toEqual({ name: 'sam-claude-3', adapter: 'claude' });
    expect(row.summary).toBe("Connect your own agent as 'sam-claude-3'");
  });

  it('a seat the owner already holds in this pod keeps its name on reconnect', async () => {
    const here = await pod('reconnect', [owner._id]);
    await install(here, 'sam-codex');

    const result = await proposeAction({
      podId: String(here._id),
      agentName: 'scout',
      instanceId: 'default',
      displayName: 'Scout',
      actionType: 'connect_local_agent',
      params: { name: 'sam-codex', adapter: 'codex' },
      summary: "Reconnect 'sam-codex'",
      ownerUserId: owner._id,
    });
    expect(result.ok).toBe(true);
    const row = await ApprovalAction.findById(result.approvalId).lean();
    expect(row.params.name).toBe('sam-codex');
  });

  const webhookInstall = (target, name, installedBy = owner._id, extra = {}) => AgentInstallation.create({
    podId: target._id, agentName: name, instanceId: 'default', version: '1.0.0', installedBy, status: 'active',
    config: { runtime: { runtimeType: 'webhook' } }, ...extra,
  });
  const agentUserWithKey = (name) => User.create({
    username: name, email: `${name}@agents.test`, password: 'password123', isBot: true,
    botMetadata: { agentName: name, instanceId: 'default' },
    agentRuntimeTokens: [{ tokenHash: `hash-${name}`, label: 'BYO MCP — initial issue', createdAt: new Date() }],
  });
  const suggest = async (base, podId) => {
    const response = await request(app)
      .get(`/api/registry/agents/next-free-name?base=${base}${podId ? `&podId=${podId}` : ''}`)
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    return response.body.name;
  };

  it('hands back the caller’s own BYO install whose key was never issued, so a reopen does not mint a second', async () => {
    // Path 1: the install succeeded, then the runtime-tokens request failed or
    // was abandoned. No agent user exists yet, or one exists with no key.
    const first = await pod('one', [owner._id]);
    await webhookInstall(first, 'sam-claude');
    expect(await suggest('sam-claude', first._id)).toBe('sam-claude');

    await User.create({
      username: 'sam-claude', email: 'sam-claude@agents.test', password: 'password123', isBot: true,
      botMetadata: { agentName: 'sam-claude', instanceId: 'default' }, agentRuntimeTokens: [],
    });
    expect(await suggest('sam-claude', first._id)).toBe('sam-claude');
  });

  it('hands the name back only for the pod being installed into', async () => {
    // Elsewhere the name would put the same identity into a second pod.
    const first = await pod('one', [owner._id]);
    const second = await pod('two', [owner._id]);
    await webhookInstall(first, 'sam-claude');
    expect(await suggest('sam-claude', second._id)).toBe('sam-claude-2');
    expect(await suggest('sam-claude')).toBe('sam-claude-2');
  });

  it('keeps the name taken when the agent already holds a key from another pod', async () => {
    // Path 2: runtime-tokens answered existing:true and the person backed out at
    // "replace the running key". That agent has a working key, so its name is
    // not free, and suggesting it would steer the next click into a replacement.
    const first = await pod('one', [owner._id]);
    const second = await pod('two', [owner._id]);
    await webhookInstall(first, 'sam-claude');
    await webhookInstall(second, 'sam-claude');
    await agentUserWithKey('sam-claude');
    expect(await suggest('sam-claude', second._id)).toBe('sam-claude-2');
  });

  it('keeps the name taken when the one install in this pod already has a keyed agent', async () => {
    // The agent-user key check alone decides this: the install is the caller's
    // own webhook install in the selected pod, with no key on the row.
    const first = await pod('one', [owner._id]);
    await webhookInstall(first, 'sam-claude');
    await agentUserWithKey('sam-claude');
    expect(await suggest('sam-claude', first._id)).toBe('sam-claude-2');
  });

  it('the connect card gets the same keyless-own-install exemption as the page', async () => {
    // Without the exemption both would skip sam-claude-2 and land on -3.
    const here = await pod('here', [owner._id]);
    const elsewhere = await pod('elsewhere', [owner._id]);
    await install(elsewhere, 'sam-claude');
    await webhookInstall(here, 'sam-claude-2');
    expect(await suggest('sam-claude', here._id)).toBe('sam-claude-2');

    const result = await proposeAction({
      podId: String(here._id),
      agentName: 'scout',
      instanceId: 'default',
      displayName: 'Scout',
      actionType: 'connect_local_agent',
      params: { name: 'sam-claude', adapter: 'claude' },
      summary: "Connect your own agent as 'sam-claude'",
      ownerUserId: owner._id,
    });
    expect(result.ok).toBe(true);
    const row = await ApprovalAction.findById(result.approvalId).lean();
    expect(row.params.name).toBe('sam-claude-2');
  });

  it('keeps names taken that are not the caller’s own unissued webhook install', async () => {
    const shared = await pod('shared', [owner._id, other._id]);
    await webhookInstall(shared, 'sam-claude', other._id); // someone else's
    await install(shared, 'sam-claude-2'); // not a webhook install
    await webhookInstall(shared, 'sam-claude-3', owner._id, { // a legacy key on the installation
      runtimeTokens: [{ tokenHash: 'legacy', label: 'legacy', createdAt: new Date() }],
    });
    expect(await suggest('sam-claude', shared._id)).toBe('sam-claude-4');
  });

  it('requires authentication and a valid base', async () => {
    expect((await request(app).get('/api/registry/agents/next-free-name?base=sam-claude')).status).toBe(401);
    const invalid = await request(app)
      .get('/api/registry/agents/next-free-name?base[$ne]=x')
      .set('Authorization', `Bearer ${token}`);
    expect(invalid.status).toBe(400);
  });
});
