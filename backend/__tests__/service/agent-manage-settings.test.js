const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const Machine = require('../../models/Machine');
const AgentMemory = require('../../models/AgentMemory');
const manageSettings = require('../../routes/registry/manage-settings');
const podAgents = require('../../routes/registry/pod-agents');
const agentConfig = require('../../routes/registry/agent-config');
const { projectSeatEnvironments, seatEnvironmentKey } = require('../../services/seatEnvironmentProjection');

const SECRET = 'agent-manage-settings-test';
const token = (user) => jwt.sign({ id: String(user._id) }, SECRET);
const config = (installation) => Object.fromEntries(installation.config || []);

describe('per-installation agent settings', () => {
  let app; let owner; let other; let admin; let podA; let podB;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', manageSettings);
    app.use('/api/registry', podAgents);
    app.use('/api/registry', agentConfig);
    owner = await User.create({ username: 'settings-owner', email: 'settings-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'settings-other', email: 'settings-other@test.com', password: 'password123' });
    admin = await User.create({ username: 'settings-admin', email: 'settings-admin@test.com', password: 'password123', role: 'admin' });
    podA = await Pod.create({ name: 'Settings A', type: 'chat', createdBy: owner._id, members: [owner._id, other._id] });
    podB = await Pod.create({ name: 'Settings B', type: 'chat', createdBy: other._id, members: [owner._id, other._id] });
  });

  afterAll(async () => closeMongoDb());

  beforeEach(async () => {
    await AgentInstallation.deleteMany({ agentName: 'settings-agent' });
    await AgentInstallation.create([
      { agentName: 'settings-agent', instanceId: 'same', podId: podA._id, version: '1', installedBy: owner._id,
        config: new Map([['wakeOnMessage', { enabled: true, humanOnly: true }], ['boardWake', { enabled: false }], ['runtime', { runtimeType: 'wrapper' }]]) },
      { agentName: 'settings-agent', instanceId: 'same', podId: podB._id, version: '1', installedBy: other._id,
        config: new Map([['wakeOnMessage', { enabled: false }], ['runtime', { runtimeType: 'wrapper' }]]) },
    ]);
  });

  afterEach(async () => {
    await User.deleteMany({ username: 'settings-runtime-bot' });
    await Machine.deleteMany({ machineId: 'machine-a' });
  });

  it('lists only installations the caller may manage', async () => {
    const response = await request(app).get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect(response.body.installations).toEqual([expect.objectContaining({
      podId: String(podA._id), podType: 'chat', status: 'active', wakeOnMessage: true, humanOnly: true, boardWake: false,
      heartbeatEnabled: false, heartbeatMinutes: 60,
    })]);
    expect(response.body.activePodCount).toBe(2);
    expect(response.body.podCount).toBe(2);
    expect(response.body.turnCap).toBe(30);
    expect(response.body.userRunCeiling).toBe(120);
    expect(response.body.writablePodId).toBe(String(podA._id));
    const otherResponse = await request(app).get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(other)}`);
    expect(otherResponse.body.writablePodId).toBe(String(podB._id));
  });

  it('reads and writes the same effort declaration the daemon selects', async () => {
    await Machine.create({ ownerUserId: owner._id, machineId: 'machine-a', name: 'Test computer',
      inventoryAt: new Date(), runtimeInventory: [{ harness: 'claude', installed: true, version: '2.1', models: null, efforts: ['high', 'xhigh'] }] });
    await User.create({
      username: 'settings-runtime-bot', email: 'settings-runtime-bot@test.com', password: 'password123',
      isBot: true, botMetadata: { agentName: 'settings-agent', instanceId: 'same', machineId: 'machine-a' },
    });
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { config: {} },
    });
    await AgentInstallation.updateOne({ podId: podB._id, agentName: 'settings-agent' }, {
      $set: { installedBy: owner._id, 'config.environment': { model: 'opus', effort: 'high' } },
    });
    const url = '/api/registry/agents/settings-agent/manage-settings?instanceId=same';
    const before = await request(app).get(url).set('Authorization', `Bearer ${token(owner)}`);
    expect(before.status).toBe(200);
    expect(before.body.writablePodId).toBe(String(podA._id));
    expect(before.body.runtimeSourcePodId).toBe(String(podB._id));
    expect(before.body.runtimeEditable).toBe(true);
    expect(before.body.runtimeManaged).toBe(true);
    expect(before.body.runtimeControls).toEqual(expect.objectContaining({ effort: 'high' }));

    const saved = await request(app)
      .patch(`/api/registry/pods/${before.body.runtimeSourcePodId}/agents/settings-agent`)
      .set('Authorization', `Bearer ${token(owner)}`)
      .send({ instanceId: 'same', config: { environment: { effort: 'xhigh' }, runtime: { adapter: 'claude' } } });
    expect(saved.status).toBe(200);
    const seat = (await projectSeatEnvironments({ installedBy: owner._id }))
      .get(seatEnvironmentKey('settings-agent', 'same'));
    expect(seat.environment.effort).toBe('xhigh');
    expect(seat.sourcePodId).toBe(String(podA._id));
    const after = await request(app).get(url).set('Authorization', `Bearer ${token(owner)}`);
    expect(after.body.runtimeManaged).toBe(true);
    expect(after.body.runtimeControls.runtimeType).toBe('wrapper');
    expect(after.body.runtimeControls.effort).toBe('xhigh');
  });

  // F355: the route rebuilt config.runtime from the request, so Settings'
  // harness switch ({ runtime: { adapter } }) erased everything else stored there.
  it('a harness switch keeps the rest of the stored runtime', async () => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.runtime': { runtimeType: 'webhook', adapter: 'claude', host: 'byo',
        webhookUrl: 'https://hooks.example.test/settings-agent', reportedCli: 'claude',
        authProfiles: { 'anthropic:default': { provider: 'anthropic', mode: 'api_key' } } } },
    });
    const saved = await request(app)
      .patch(`/api/registry/pods/${podA._id}/agents/settings-agent`)
      .set('Authorization', `Bearer ${token(owner)}`)
      .send({ instanceId: 'same', config: { runtime: { adapter: 'codex' } } });
    expect(saved.status).toBe(200);
    const row = await AgentInstallation.findOne({ podId: podA._id, agentName: 'settings-agent' }).lean();
    const runtime = (row.config instanceof Map ? Object.fromEntries(row.config) : row.config).runtime;
    expect(runtime).toEqual(expect.objectContaining({
      runtimeType: 'webhook', adapter: 'codex', host: 'byo',
      webhookUrl: 'https://hooks.example.test/settings-agent', reportedCli: 'claude',
    }));
    expect(runtime.authProfiles).toBeTruthy();
  });

  it('an admin changing the runtime type still replaces the runtime block', async () => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.runtime': { runtimeType: 'webhook', adapter: 'claude', webhookUrl: 'https://hooks.example.test/old' } },
    });
    await Pod.updateOne({ _id: podA._id }, { $addToSet: { members: admin._id } });
    const saved = await request(app)
      .patch(`/api/registry/pods/${podA._id}/agents/settings-agent`)
      .set('Authorization', `Bearer ${token(admin)}`)
      .send({ instanceId: 'same', config: { runtime: { runtimeType: 'wrapper', adapter: 'codex' } } });
    expect(saved.status).toBe(200);
    const row = await AgentInstallation.findOne({ podId: podA._id, agentName: 'settings-agent' }).lean();
    const runtime = (row.config instanceof Map ? Object.fromEntries(row.config) : row.config).runtime;
    expect(runtime.runtimeType).toBe('wrapper');
    expect(runtime.webhookUrl).toBeUndefined();
    await Pod.updateOne({ _id: podA._id }, { $pull: { members: admin._id } });
  });

  it('reports the process from the agent listener, not the computer heartbeat', async () => {
    await Machine.create({ ownerUserId: owner._id, machineId: 'machine-a', name: 'Test computer', lastSeenAt: null });
    await User.create({
      username: 'settings-runtime-bot', email: 'settings-runtime-bot@test.com', password: 'password123',
      isBot: true, botMetadata: { agentName: 'settings-agent', instanceId: 'same', machineId: 'machine-a' },
      agentRuntimeTokens: [{ tokenHash: 'listener-hash', lastUsedAt: new Date(Date.now() - 10_000) }],
    });
    const url = '/api/registry/agents/settings-agent/manage-settings?instanceId=same';
    const polling = await request(app).get(url).set('Authorization', `Bearer ${token(owner)}`);
    expect(polling.status).toBe(200);
    expect(polling.body.processConnected).toBe(true);

    await Machine.updateOne({ machineId: 'machine-a' }, { $set: { lastSeenAt: new Date() } });
    await User.updateOne({ username: 'settings-runtime-bot' },
      { $set: { 'agentRuntimeTokens.0.lastUsedAt': new Date(Date.now() - 10 * 60_000) } });
    const silent = await request(app).get(url).set('Authorization', `Bearer ${token(owner)}`);
    expect(silent.body.processConnected).toBe(false);
  });

  it('does not present a standalone CLI preference as a running effort', async () => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.environment': { model: 'opus', effort: 'max' } },
    });
    const response = await request(app)
      .get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect(response.body.runtimeManaged).toBe(false);
    expect(response.body.runtimeControls.effort).toBe('');
    expect(response.body.runtimeSavedControls.effort).toBe('max');
  });

  // D247: a listener agent (`agent run` from the connect page) has no machine
  // binding. It is still the person's own agent, and its run reads these
  // controls from the server, so they stay editable on add and after.
  it('lets the owner edit a listener agent\'s runtime controls without a machine binding', async () => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.runtime': { runtimeType: 'webhook' }, 'config.environment': { model: 'gpt-6-sol', effort: 'high' } },
    });
    const response = await request(app)
      .get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect(response.body.runtimeEditable).toBe(true);
    expect(response.body.runtimeSourcePodId).toBe(String(podA._id));
    expect(response.body.runtimeSavedControls).toEqual(expect.objectContaining({ model: 'gpt-6-sol', effort: 'high' }));
    expect(response.body.harnessCatalog.map((entry) => entry.id)).toEqual(
      ['claude', 'codex', 'opencode', 'qwen', 'goose', 'hermes', 'pi', 'dsh']);
  });

  it('serves the harness catalogue to a signed-in person before any agent exists', async () => {
    const anonymous = await request(app).get('/api/registry/harness-catalog');
    expect(anonymous.status).toBe(401);
    const response = await request(app).get('/api/registry/harness-catalog')
      .set('Authorization', `Bearer ${token(other)}`);
    expect(response.status).toBe(200);
    expect(response.body.harnesses[1]).toEqual({ id: 'codex', label: 'Codex',
      models: expect.arrayContaining(['gpt-6.1-sol']), efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  });

  it('does not present a hosted runtime preference as its running model or effort', async () => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.runtime': { runtimeType: 'internal' },
        'config.environment': { model: 'opus', effort: 'max' } },
    });
    const response = await request(app)
      .get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect(response.body.runtimeManaged).toBe(false);
    expect(response.body.runtimeEditable).toBe(false);
    expect(response.body.runtimeSourcePodId).toBeNull();
    expect(response.body.runtimeControls.model).toBe('');
    expect(response.body.runtimeControls.effort).toBe('');
    expect(response.body.runtimeSavedControls.effort).toBe('max');
  });

  // The hosted engine floors a heartbeat to hourly per install and caps an
  // owner's hosted heartbeats a day (hostedEngine.ts, D244). The wake panel
  // reads both from here, so it neither offers nor previews more than runs.
  it('tells the wake panel a hosted agent\'s heartbeat floor and daily cap', async () => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.runtime': { runtimeType: 'hosted' },
        'config.hosted': { engine: 'native', provisionedAt: new Date() } },
    });
    const get = () => request(app)
      .get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    let response = await get();
    expect(response.status).toBe(200);
    expect(response.body.hostedHeartbeat).toEqual({ minMinutes: 60, runsPerDay: 6 });
    // Each row carries its own bounds: runtimeType is per installation, so a
    // row of the same identity that isn't hosted keeps every interval.
    const rows = Object.fromEntries(response.body.installations.map((row) => [row.podId, row.hostedHeartbeat]));
    expect(rows[String(podA._id)]).toEqual({ minMinutes: 60, runsPerDay: 6 });
    Object.entries(rows).filter(([podId]) => podId !== String(podA._id))
      .forEach(([, bounds]) => expect(bounds).toBeNull());

    process.env.HOSTED_HEARTBEAT_RUNS_PER_DAY = '0';
    try {
      response = await get();
      expect(response.body.hostedHeartbeat).toEqual({ minMinutes: 60, runsPerDay: 0 });
    } finally {
      delete process.env.HOSTED_HEARTBEAT_RUNS_PER_DAY;
    }
  });

  // The Durable Object answers mentions and first contact only, and a
  // deprovisioned native row runs nothing, so neither runs a heartbeat.
  it.each([
    ['on the Durable Object', {}],
    ['deprovisioned on the native engine', { engine: 'native', provisionedAt: null }],
  ])('a hosted agent %s is told it runs no heartbeat', async (_label, hosted) => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.runtime': { runtimeType: 'hosted' }, 'config.hosted': hosted },
    });
    const response = await request(app)
      .get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.body.hostedHeartbeat).toEqual({ minMinutes: 60, runsPerDay: 0 });
  });

  it('gives no hosted heartbeat bounds to an agent that is not hosted', async () => {
    const response = await request(app)
      .get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect(response.body.hostedHeartbeat).toBeNull();
    expect(response.body.installations.length).toBeGreaterThan(0);
    response.body.installations.forEach((row) => expect(row.hostedHeartbeat).toBeNull());
  });

  it('shows the installation owner’s quota when an admin opens settings', async () => {
    await User.updateOne({ _id: owner._id }, { $set: { 'entitlements.pro': true } });
    const response = await request(app).get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(admin)}`);
    expect(response.status).toBe(200);
    expect(response.body.turnCap).toBe(200);
    expect(response.body.userRunCeiling).toBe(300);
    await User.updateOne({ _id: owner._id }, { $set: { 'entitlements.pro': false } });
  });

  it('counts active connections separately from installed pod rows', async () => {
    await AgentInstallation.updateOne({ podId: podB._id, agentName: 'settings-agent' }, { status: 'paused' });
    const response = await request(app).get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(admin)}`);
    expect(response.status).toBe(200);
    expect(response.body.podCount).toBe(2);
    expect(response.body.activePodCount).toBe(1);
    expect(response.body.installations.find((entry) => entry.podId === String(podB._id)).status).toBe('paused');
  });

  it('writes one installation and preserves its human-only default and runtime', async () => {
    const response = await request(app)
      .patch(`/api/registry/agents/settings-agent/manage-settings/pods/${podA._id}?instanceId=same`)
      .set('Authorization', `Bearer ${token(owner)}`)
      .send({ wakeOnMessage: false, humanOnly: false, boardWake: true,
        heartbeatEnabled: true, heartbeatMinutes: 90 });
    expect(response.status).toBe(200);
    const [a, b] = await Promise.all([
      AgentInstallation.findOne({ podId: podA._id, agentName: 'settings-agent' }),
      AgentInstallation.findOne({ podId: podB._id, agentName: 'settings-agent' }),
    ]);
    expect(config(a).wakeOnMessage).toEqual({ enabled: false, humanOnly: false });
    expect(config(a).boardWake).toEqual({ enabled: true });
    expect(config(a).heartbeat).toEqual({ enabled: true, everyMinutes: 90 });
    expect(config(a).runtime).toEqual({ runtimeType: 'wrapper' });
    expect(config(b).wakeOnMessage).toEqual({ enabled: false });
    expect(config(b).heartbeat).toBeUndefined();
  });

  it('refuses another pod member and invalid intervals before writing', async () => {
    const url = `/api/registry/agents/settings-agent/manage-settings/pods/${podA._id}?instanceId=same`;
    const body = { wakeOnMessage: false, humanOnly: true, boardWake: true,
      heartbeatEnabled: true, heartbeatMinutes: 30 };
    const denied = await request(app).patch(url).set('Authorization', `Bearer ${token(other)}`).send(body);
    const malformed = await request(app).patch(url).set('Authorization', `Bearer ${token(owner)}`)
      .send({ ...body, heartbeatMinutes: 0 });
    expect(denied.status).toBe(403);
    expect(malformed.status).toBe(400);
    const unchanged = await AgentInstallation.findOne({ podId: podA._id, agentName: 'settings-agent' });
    expect(config(unchanged).wakeOnMessage).toEqual({ enabled: true, humanOnly: true });
  });

  it('turns the heartbeat off without an interval and keeps the stored one', async () => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.heartbeat': { enabled: true, everyMinutes: 45 } },
    });
    const response = await request(app)
      .patch(`/api/registry/agents/settings-agent/manage-settings/pods/${podA._id}?instanceId=same`)
      .set('Authorization', `Bearer ${token(owner)}`)
      .send({ wakeOnMessage: true, humanOnly: true, boardWake: false, heartbeatEnabled: false });
    expect(response.status).toBe(200);
    expect(response.body.settings).toEqual(expect.objectContaining({
      heartbeatEnabled: false, heartbeatMinutes: 45,
    }));
    const saved = await AgentInstallation.findOne({ podId: podA._id, agentName: 'settings-agent' });
    expect(config(saved).heartbeat).toEqual({ enabled: false, everyMinutes: 45 });

    // With no stored interval, nothing is invented and the default still reads back.
    const fresh = await request(app)
      .patch(`/api/registry/agents/settings-agent/manage-settings/pods/${podB._id}?instanceId=same`)
      .set('Authorization', `Bearer ${token(other)}`)
      .send({ wakeOnMessage: false, humanOnly: false, boardWake: false, heartbeatEnabled: false });
    expect(fresh.status).toBe(200);
    expect(fresh.body.settings.heartbeatMinutes).toBe(60);
    const unset = await AgentInstallation.findOne({ podId: podB._id, agentName: 'settings-agent' });
    expect(config(unset).heartbeat).toEqual({ enabled: false });
  });

  it('names the field a rejected wake write got wrong, and writes nothing', async () => {
    const url = `/api/registry/agents/settings-agent/manage-settings/pods/${podA._id}?instanceId=same`;
    const body = { wakeOnMessage: false, humanOnly: false, boardWake: true, heartbeatEnabled: true, heartbeatMinutes: 30 };
    const send = (patch) => request(app).patch(url).set('Authorization', `Bearer ${token(owner)}`)
      .send({ ...body, ...patch });
    const cases = [
      [{ wakeOnMessage: 'yes' }, 'wakeOnMessage'],
      [{ humanOnly: undefined }, 'humanOnly'],
      [{ boardWake: 1 }, 'boardWake'],
      [{ heartbeatEnabled: null }, 'heartbeatEnabled'],
      [{ heartbeatMinutes: undefined }, 'heartbeatMinutes'],
      [{ heartbeatMinutes: 0 }, 'heartbeatMinutes'],
      [{ heartbeatEnabled: false, heartbeatMinutes: 1441 }, 'heartbeatMinutes'],
      [{ heartbeatEnabled: false, heartbeatMinutes: '30' }, 'heartbeatMinutes'],
      // Omitted means absent: null is a value sent, and is refused.
      [{ heartbeatEnabled: false, heartbeatMinutes: null }, 'heartbeatMinutes'],
    ];
    for (const [patch, field] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const response = await send(patch);
      expect({ patch, status: response.status, field: response.body.field }).toEqual({ patch, status: 400, field });
      expect(response.body.error).toContain(field);
    }
    const unchanged = await AgentInstallation.findOne({ podId: podA._id, agentName: 'settings-agent' });
    expect(config(unchanged).wakeOnMessage).toEqual({ enabled: true, humanOnly: true });
    expect(config(unchanged).heartbeat).toBeUndefined();
  });

  it('lets an instance admin manage an installation they did not create', async () => {
    const listed = await request(app).get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(admin)}`);
    expect(listed.status).toBe(200);
    expect(listed.body.installations).toHaveLength(2);
    const saved = await request(app)
      .patch(`/api/registry/agents/settings-agent/manage-settings/pods/${podB._id}?instanceId=same`)
      .set('Authorization', `Bearer ${token(admin)}`)
      .send({ wakeOnMessage: true, humanOnly: false, boardWake: false,
        heartbeatEnabled: true, heartbeatMinutes: 120 });
    expect(saved.status).toBe(200);
    expect(config(await AgentInstallation.findOne({ podId: podB._id, agentName: 'settings-agent' })).heartbeat)
      .toEqual({ enabled: true, everyMinutes: 120 });
  });

  it('removes one pod installation while keeping the agent identity and memory', async () => {
    const bot = await User.create({
      username: 'settings-agent-same', email: 'settings-agent@test.com', password: 'password123',
      isBot: true, botMetadata: { agentName: 'settings-agent', instanceId: 'same' },
    });
    const memory = await AgentMemory.create({
      agentName: 'settings-agent', instanceId: 'same',
      sections: { long_term: { content: 'Remember this', visibility: 'private', byteSize: 13 } },
    });
    const response = await request(app)
      .delete(`/api/registry/agents/settings-agent/pods/${podA._id}?instanceId=same`)
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect((await AgentInstallation.findOne({ podId: podA._id, agentName: 'settings-agent' })).status).toBe('uninstalled');
    expect((await AgentInstallation.findOne({ podId: podB._id, agentName: 'settings-agent' })).status).toBe('active');
    expect(await User.exists({ _id: bot._id })).toBeTruthy();
    expect(await AgentMemory.exists({ _id: memory._id })).toBeTruthy();
  });

  it('keeps the pod creator’s authority to remove an installation', async () => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, { installedBy: other._id });
    const response = await request(app)
      .delete(`/api/registry/agents/settings-agent/pods/${podA._id}?instanceId=same`)
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect((await AgentInstallation.findOne({ podId: podA._id, agentName: 'settings-agent' })).status).toBe('uninstalled');
  });

  it('never removes another instance when the requested instance is missing', async () => {
    const response = await request(app)
      .delete(`/api/registry/agents/settings-agent/pods/${podA._id}?instanceId=missing`)
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(404);
    expect((await AgentInstallation.findOne({
      podId: podA._id, agentName: 'settings-agent', instanceId: 'same',
    })).status).toBe('active');
  });

  // Each person's 1:1 room with the agent carries the agent's name, so the
  // owner saw identical "direct" rows. The owner isn't a member of anyone
  // else's room and doesn't learn who talks to the agent: those rooms reach
  // the owner only as a count, never as a row, id or name.
  it('lists only the caller\'s own direct room and counts the others', async () => {
    const bot = await User.create({ username: 'settings-room-bot', email: 'settings-room-bot@test.com', password: 'password123',
      isBot: true, botMetadata: { agentName: 'settings-room-agent', instanceId: 'default' } });
    const third = await User.create({ username: 'settings-third', email: 'settings-third@test.com', password: 'password123' });
    const mine = await Pod.create({ name: 'settings-room-agent', type: 'agent-room', createdBy: bot._id, members: [owner._id, bot._id] });
    const theirs = await Pod.create({ name: 'settings-room-agent', type: 'agent-room', createdBy: bot._id, members: [other._id, bot._id] });
    const thirds = await Pod.create({ name: 'settings-room-agent', type: 'agent-room', createdBy: bot._id, members: [third._id, bot._id] });
    try {
      // The others' rooms are older, so an unfiltered fallback would pick one.
      await AgentInstallation.create([
        { agentName: 'settings-room-agent', instanceId: 'default', podId: theirs._id, version: '1', installedBy: owner._id, createdAt: new Date('2026-01-01') },
        { agentName: 'settings-room-agent', instanceId: 'default', podId: thirds._id, version: '1', installedBy: owner._id, createdAt: new Date('2026-01-02') },
        { agentName: 'settings-room-agent', instanceId: 'default', podId: mine._id, version: '1', installedBy: owner._id, createdAt: new Date('2026-01-03') },
      ]);
      const response = await request(app).get('/api/registry/agents/settings-room-agent/manage-settings?instanceId=default')
        .set('Authorization', `Bearer ${token(owner)}`);
      expect(response.status).toBe(200);
      expect(response.body.installations.map((row) => row.podId)).toEqual([String(mine._id)]);
      expect(response.body.otherDirectRoomCount).toBe(2);
      expect(response.body.writablePodId).toBe(String(mine._id));
      expect(response.body.podCount).toBe(3);
      // runtimeSourcePodId stays: runtime saves must reach the pod the daemon
      // reads, and a bare id names no one (the room 404s for a non-member).
      const withoutSource = (data) => JSON.stringify({ ...data, runtimeSourcePodId: undefined });
      const body = withoutSource(response.body);
      for (const id of [theirs._id, thirds._id, other._id, third._id]) expect(body).not.toContain(String(id));
      expect(body).not.toContain('settings-other');
      expect(body).not.toContain('settings-third');

      // The person in a room sees it as their own and the rest only as a count.
      await AgentInstallation.updateMany({ agentName: 'settings-room-agent' }, { $set: { installedBy: other._id } });
      const theirView = await request(app).get('/api/registry/agents/settings-room-agent/manage-settings?instanceId=default')
        .set('Authorization', `Bearer ${token(other)}`);
      expect(theirView.body.installations.map((row) => row.podId)).toEqual([String(theirs._id)]);
      expect(theirView.body.otherDirectRoomCount).toBe(2);
      expect(withoutSource(theirView.body)).not.toContain(String(mine._id));

      // With no room of their own, nothing names any room.
      await AgentInstallation.deleteMany({ podId: mine._id });
      await AgentInstallation.updateMany({ agentName: 'settings-room-agent' }, { $set: { installedBy: owner._id } });
      const noneOwn = await request(app).get('/api/registry/agents/settings-room-agent/manage-settings?instanceId=default')
        .set('Authorization', `Bearer ${token(owner)}`);
      expect(noneOwn.body.installations).toEqual([]);
      expect(noneOwn.body.otherDirectRoomCount).toBe(2);
      // The page still has to load the agent to manage it, so one id comes
      // back as the writable pod. No row, name or member does.
      expect([String(theirs._id), String(thirds._id)]).toContain(noneOwn.body.writablePodId);
      const loadable = JSON.stringify({ ...noneOwn.body, runtimeSourcePodId: undefined, writablePodId: undefined });
      for (const id of [theirs._id, thirds._id, other._id, third._id]) expect(loadable).not.toContain(String(id));
    } finally {
      await AgentInstallation.deleteMany({ agentName: 'settings-room-agent' });
      await Pod.deleteMany({ _id: { $in: [mine._id, theirs._id, thirds._id] } });
      await User.deleteMany({ _id: { $in: [bot._id, third._id] } });
    }
  });
});
