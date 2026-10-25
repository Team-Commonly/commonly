/** Wave 1: real HTTP mount table, real auth, Mongo and PostgreSQL.
 * Only the external OAuth provider is stubbed. No model/middleware/service mocks.
 * These scenarios deliberately run only in the Tier 1 service job.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { setupMongoDb, closeMongoDb, setupPgDb, closePgDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const RoomGrant = require('../../models/RoomGrant');
const ApprovalAction = require('../../models/ApprovalAction');
const OAuthLoginState = require('../../models/OAuthLoginState');
const AgentEvent = require('../../models/AgentEvent');
const File = require('../../models/File');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { hash } = require('../../utils/secret');

const tier1 = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
tier1('commonly verify wave 1 — production HTTP routes', () => {
  let app;
  let pg;
  let owner;
  let other;
  let agent;
  let installation;
  let pod;
  let ownerToken;
  let otherToken;
  const agentToken = 'cm_agent_verify-wave1-seat';
  const human = (token) => ({ Authorization: `Bearer ${token}` });
  const seat = () => human(agentToken);

  beforeAll(async () => {
    // Importing the factory must not connect Mongo at module scope.
    expect(mongoose.connection.readyState).toBe(0);
    const { createApp } = require('../../server');
    expect(() => createApp({ startServices: true })).toThrow('Service startup is singleton-only');
    expect(mongoose.connection.readyState).toBe(0);
    await setupMongoDb();
    pg = await setupPgDb();
    app = createApp();
    owner = await User.create({ username: 'verify-owner', email: 'verify-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'verify-other', email: 'verify-other@test.com', password: 'password123' });
    ownerToken = jwt.sign({ id: String(owner._id) }, process.env.JWT_SECRET);
    otherToken = jwt.sign({ id: String(other._id) }, process.env.JWT_SECRET);
    agent = await User.create({
      username: AgentIdentityService.buildAgentUsername('openclaw', 'verify-wave1'),
      email: 'verify-seat@test.com', password: 'password123', isBot: true, botType: 'agent',
      botMetadata: { agentName: 'openclaw', instanceId: 'verify-wave1' },
      agentRuntimeTokens: [{ tokenHash: hash(agentToken), lastUsedAt: new Date() }],
    });
    pod = await Pod.create({ name: 'Verify wave 1', type: 'team', publicRead: false, joinPolicy: 'invite-only', createdBy: owner._id, members: [owner._id, other._id, agent._id] });
    installation = await AgentInstallation.create({
      agentName: 'openclaw', instanceId: 'verify-wave1', podId: pod._id,
      installedBy: owner._id, version: '1.0.0', status: 'active',
      config: { runtime: { runtimeType: 'native' }, tools: ['computer_request_takeover'] },
    });
    for (const user of [owner, other, agent]) {
      await pg.query('INSERT INTO users (_id, username, is_bot) VALUES ($1,$2,$3)', [String(user._id), user.username, user.isBot]);
    }
    await pg.query('INSERT INTO pods (id,name,type,created_by) VALUES ($1,$2,$3,$4)', [String(pod._id), pod.name, pod.type, String(owner._id)]);
    await pg.query('INSERT INTO messages (pod_id,user_id,content) VALUES ($1,$2,$3)', [String(pod._id), String(owner._id), 'wave1 durable chat witness']);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (app) await new Promise((resolve) => app.locals.socketServer.close(resolve));
    const { pool } = require('../../config/db-pg');
    if (pool) await pool.end();
    await closePgDb();
    await closeMongoDb();
  });

  test('attenuation refuses wider tools and persists a strict subset', async () => {
    const grantId = randomUUID();
    await RoomGrant.create({ grantId, connectionId: 'verify-connection', installationId: String(installation._id),
      target: { kind: 'pod', id: String(pod._id) }, audience: [String(agent._id)],
      tools: ['read', 'search'], writeMode: 'read', brokerId: 'verify-broker', expiresAt: new Date(Date.now() + 3600000) });
    const url = `/api/grants/${grantId}/attenuate`;
    const widened = await request(app).post(url).set(seat()).send({ tools: ['write'] });
    expect({ status: widened.status, error: widened.body.error }).toEqual({ status: 400, error: 'grant_not_attenuated' });
    expect(await RoomGrant.countDocuments({ parentGrantId: grantId })).toBe(0);
    const narrowed = await request(app).post(url).set(seat()).send({ tools: ['read'] }).expect(201);
    const stored = await RoomGrant.findOne({ grantId: narrowed.body.grantId }).lean();
    expect(stored.tools).toEqual(['read']);
    expect(stored.parentGrantId).toBe(grantId);
    expect(stored.audience).toEqual([String(agent._id)]);
  });

  test('approval resolution belongs to its owner, even when another human is a pod member', async () => {
    const action = await ApprovalAction.create({ podId: pod._id, ownerUserId: owner._id,
      agentName: 'openclaw', instanceId: 'verify-wave1', actionType: 'create_pod',
      params: { name: 'Must not execute' }, summary: 'Verify owner decision', expiresAt: new Date(Date.now() + 60000) });
    const url = `/api/approvals/${action._id}/resolve`;
    await request(app).post(url).set(human(otherToken)).send({ decision: 'approved' }).expect(403);
    expect((await ApprovalAction.findById(action._id)).status).toBe('flagged');
    await request(app).post(url).set(human(ownerToken)).send({ decision: 'declined' }).expect(200);
    const stored = await ApprovalAction.findById(action._id);
    expect(stored.decision).toBe('declined');
    expect(String(stored.resolvedBy)).toBe(String(owner._id));
    expect(await Pod.countDocuments({ name: 'Must not execute' })).toBe(0);
  });

  test('OAuth callback claims state once; exchange code creates one usable human session', async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'verify-client';
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'verify-secret';
    owner.authProviders = [{ provider: 'github', providerId: '514', email: owner.email }];
    await owner.save();
    const state = await OAuthLoginState.create({ provider: 'github', state: randomUUID(), expiresAt: new Date(Date.now() + 60000) });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: 'upstream-test-only' } });
    jest.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (url === 'https://api.github.com/user') return { data: { id: 514, login: owner.username } };
      if (url === 'https://api.github.com/user/emails') return { data: [{ email: owner.email, verified: true, primary: true }] };
      throw new Error('Unexpected upstream URL');
    });
    const callback = `/api/auth/oauth/github/callback?state=${state.state}&code=provider-code`;
    const first = await request(app).get(callback).expect(302);
    const code = new URL(first.headers.location).searchParams.get('code');
    expect(code).toBeTruthy();
    expect(first.headers.location).not.toContain('token=');
    const replay = await request(app).get(callback).expect(302);
    expect(replay.headers.location).toContain('state_invalid');
    expect(post).toHaveBeenCalledTimes(1);
    const exchanged = await request(app).post('/api/auth/oauth/exchange').send({ code }).expect(200);
    expect(jwt.verify(exchanged.body.token, process.env.JWT_SECRET).id).toBe(String(owner._id));
    const session = await request(app).get('/api/auth/user').set(human(exchanged.body.token)).expect(200);
    expect(String(session.body._id)).toBe(String(owner._id));
    const landing = await request(app).get('/api/pods').set(human(exchanged.body.token)).expect(200);
    expect(landing.body.map((entry) => String(entry._id))).toContain(String(pod._id));
    await request(app).post('/api/auth/oauth/exchange').send({ code }).expect(400);
    expect((await OAuthLoginState.findById(state._id)).exchangedAt).toBeTruthy();
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  });

  test('agent upload is bound to the URL pod and stores actual bytes', async () => {
    const uploaded = await request(app).post(`/api/agents/runtime/pods/${pod._id}/uploads`).set(seat())
      .field('podId', String(other._id)).attach('file', Buffer.from('wave1 upload bytes'), 'verify.txt').expect(200);
    const stored = await File.findOne({ fileName: uploaded.body.fileName }).lean();
    expect(String(stored.podId)).toBe(String(pod._id));
    expect(String(stored.uploadedBy)).toBe(String(agent._id));
    const { getObjectStore } = require('../../services/objectStore');
    const bytes = await getObjectStore().get(uploaded.body.fileName);
    expect(bytes).toBeTruthy();
    const chunks = [];
    for await (const chunk of bytes.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('wave1 upload bytes');
    const refused = await Pod.create({ name: 'Other room', type: 'team', createdBy: other._id, members: [other._id] });
    await request(app).post(`/api/agents/runtime/pods/${refused._id}/uploads`).set(seat())
      .attach('file', Buffer.from('must not persist'), 'refused.txt').expect(403);
    expect(await File.countDocuments({ originalName: 'refused.txt' })).toBe(0);
  });

  test('computer press gates owner and computer capability before attempting a browser action', async () => {
    const keys = ['AGENT_COMPUTER_ENABLED', 'AGENT_COMPUTER_STEEL_API_URL_TEMPLATE', 'AGENT_COMPUTER_STEEL_CDP_URL_TEMPLATE', 'AGENT_COMPUTER_WAKER_URL', 'AGENT_COMPUTER_WAKER_TOKEN'];
    const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, { AGENT_COMPUTER_ENABLED: 'true', AGENT_COMPUTER_STEEL_API_URL_TEMPLATE: 'http://127.0.0.1:1', AGENT_COMPUTER_STEEL_CDP_URL_TEMPLATE: 'http://127.0.0.1:1', AGENT_COMPUTER_WAKER_URL: 'http://127.0.0.1:1', AGENT_COMPUTER_WAKER_TOKEN: 'verify-only' });
      const url = `/api/agent-computer/${installation._id}/press`;
      const otherPress = await request(app).post(url).set(human(otherToken)).send({ key: 'Enter', frameRevision: 'stale' }).expect(403);
      expect(otherPress.body.code).toBe('not_owner');
      await AgentInstallation.updateOne({ _id: installation._id }, { $set: { 'config.tools': [] } });
      const ownerPress = await request(app).post(url).set(human(ownerToken)).send({ key: 'Enter', frameRevision: 'stale' }).expect(403);
      expect(ownerPress.body.code).toBe('computer_not_granted');
    } finally { for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } }
  });

  test('CAP context and message reads return durable PG content and exclude another pod', async () => {
    const foreign = await Pod.create({ name: 'Foreign content room', type: 'team', publicRead: false, joinPolicy: 'invite-only', createdBy: other._id, members: [other._id] });
    await pg.query('INSERT INTO pods (id,name,type,created_by) VALUES ($1,$2,$3,$4)', [String(foreign._id), foreign.name, foreign.type, String(other._id)]);
    await pg.query('INSERT INTO messages (pod_id,user_id,content) VALUES ($1,$2,$3)', [String(foreign._id), String(other._id), 'foreign content must stay private']);
    for (const suffix of ['context', 'messages']) {
      const result = await request(app).get(`/api/agents/runtime/pods/${pod._id}/${suffix}`).set(seat()).expect(200);
      expect(JSON.stringify(result.body)).toContain('wave1 durable chat witness');
      const refused = await request(app).get(`/api/agents/runtime/pods/${foreign._id}/${suffix}`).set(seat()).expect(403);
      expect(JSON.stringify(refused.body)).not.toContain('foreign content must stay private');
    }
  });

  test('CAP renew changes only the matching delivery nonce owned by this seat', async () => {
    const old = new Date(Date.now() - 60000);
    const event = await AgentEvent.create({ agentName: 'openclaw', instanceId: 'verify-wave1', podId: pod._id,
      type: 'verify.wave1', status: 'delivered', deliveryNonce: 'current-nonce', deliveredAt: old });
    const foreign = await AgentEvent.create({ agentName: 'openclaw', instanceId: 'foreign-seat', podId: pod._id,
      type: 'verify.wave1', status: 'delivered', deliveryNonce: 'foreign-nonce', deliveredAt: old });
    const url = '/api/agents/runtime/events/renew';
    const wrong = await request(app).post(url).set(seat()).send({ events: [{ eventId: String(event._id), deliveryId: 'old-nonce' }] }).expect(200);
    expect(wrong.body.renewed).toEqual([]);
    expect((await AgentEvent.findById(event._id)).deliveredAt.getTime()).toBe(old.getTime());
    const valid = await request(app).post(url).set(seat()).send({ events: [
      { eventId: String(event._id), deliveryId: 'current-nonce' },
      { eventId: String(foreign._id), deliveryId: 'foreign-nonce' },
    ] }).expect(200);
    expect(valid.body.renewed).toEqual([String(event._id)]);
    const stored = await AgentEvent.findById(event._id);
    expect(stored.deliveredAt.getTime()).toBeGreaterThan(old.getTime());
    expect(stored.status).toBe('delivered');
    const untouched = await AgentEvent.findById(foreign._id);
    expect(untouched.deliveredAt.getTime()).toBe(old.getTime());
    expect(untouched.status).toBe('delivered');
  });
});
