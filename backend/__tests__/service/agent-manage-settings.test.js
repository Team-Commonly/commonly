const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const Machine = require('../../models/Machine');
const AgentMemory = require('../../models/AgentMemory');
const AgentRun = require('../../models/AgentRun');
const manageSettings = require('../../routes/registry/manage-settings');
const podAgents = require('../../routes/registry/pod-agents');
const agentConfig = require('../../routes/registry/agent-config');
const tasksApi = require('../../routes/tasksApi');
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
    app.use('/api/tasks', tasksApi);
    owner = await User.create({ username: 'settings-owner', email: 'settings-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'settings-other', email: 'settings-other@test.com', password: 'password123' });
    admin = await User.create({ username: 'settings-admin', email: 'settings-admin@test.com', password: 'password123', role: 'admin' });
    podA = await Pod.create({ name: 'Settings A', type: 'chat', createdBy: owner._id, members: [owner._id, other._id] });
    podB = await Pod.create({ name: 'Settings B', type: 'chat', createdBy: other._id, members: [owner._id, other._id] });
  });

  afterAll(async () => closeMongoDb());

  beforeEach(async () => {
    await AgentInstallation.deleteMany({ agentName: 'settings-agent' });
    await AgentRun.deleteMany({ agentName: 'settings-agent' });
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
      podId: String(podA._id), status: 'active', wakeOnMessage: true, humanOnly: true, boardWake: false,
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

  it('reads the actual latest run model only within the managed owner and pod', async () => {
    const base = { agentName: 'settings-agent', instanceId: 'same', trigger: 'manual', status: 'succeeded' };
    await AgentRun.create([
      { ...base, userId: String(owner._id), podId: podA._id, startedAt: new Date('2026-10-25T01:00:00Z'), turns: [{ turnIndex: 0, model: 'actual-model', elapsedMs: 1 }] },
      { ...base, userId: String(other._id), podId: podA._id, startedAt: new Date('2026-10-25T02:00:00Z'), turns: [{ turnIndex: 0, model: 'private-owner-model', elapsedMs: 1 }] },
      { ...base, userId: String(owner._id), podId: podB._id, startedAt: new Date('2026-10-25T03:00:00Z'), turns: [{ turnIndex: 0, model: 'private-pod-model', elapsedMs: 1 }] },
    ]);
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.runtime': { runtimeType: 'hosted', model: 'saved-but-never-run' } },
    });
    const response = await request(app).get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect(response.body.runtimeRun).toEqual(expect.objectContaining({ model: 'actual-model', status: 'succeeded' }));
    expect(JSON.stringify(response.body.runtimeRun)).not.toContain('private-owner-model');
    expect(JSON.stringify(response.body.runtimeRun)).not.toContain('private-pod-model');
    await AgentRun.create({ ...base, userId: String(owner._id), podId: podA._id,
      startedAt: new Date('2026-10-25T04:00:00Z'), status: 'failed', turns: [] });
    const failed = await request(app).get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(failed.body.runtimeRun.model).toBeNull();
    await AgentRun.deleteMany({ agentName: 'settings-agent' });
  });

  it('reads the hosted engine meter and omits usage for non-hosted installs', async () => {
    await AgentRun.create({ agentName: 'settings-agent', instanceId: 'same', trigger: 'manual',
      status: 'succeeded', userId: String(owner._id), podId: podA._id, startedAt: new Date(), turns: [] });
    const url = '/api/registry/agents/settings-agent/manage-settings?instanceId=same';
    const read = () => request(app).get(url).set('Authorization', `Bearer ${token(owner)}`);
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.runtime': { runtimeType: 'hosted' }, 'config.hosted': { engine: 'native', provisionedAt: new Date().toISOString() } },
    });
    const native = await read();
    expect(native.status).toBe(200);
    expect(native.body.usage).toEqual(expect.objectContaining({ used: 1, cap: 30 }));
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.hosted': { engine: 'durable-object' } },
    });
    const worker = await read();
    expect(worker.body.usage).toEqual(expect.objectContaining({ used: 0, cap: 30 }));
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.runtime': { runtimeType: 'native' } },
    });
    expect((await read()).body.usage).toBeNull();
  });

  it.each(['runtime-token claim', 'instance-id claim'])('shows a held task to members only (%s)', async (claimForm) => {
    const Task = require('../../models/Task');
    await Task.deleteMany({ taskId: 'TASK-546' });
    await Pod.updateOne({ _id: podB._id }, { $pull: { members: admin._id } });
    await User.deleteMany({ username: 'settings-runtime-bot' });
    const bot = await User.create({ username: 'settings-runtime-bot', email: 'settings-runtime-bot@test.com',
      password: 'password123', isBot: true, botType: 'agent',
      botMetadata: { agentName: 'settings-agent', instanceId: 'same' },
      agentRuntimeTokens: [{ tokenHash: require('crypto').createHash('sha256').update('cm_agent_settings_claim_fixture').digest('hex'), label: 'test', createdAt: new Date() }] });
    await Task.create({ podId: podA._id, taskNum: 546, taskId: 'TASK-546', title: 'Private title',
      status: 'pending' });
    await Pod.updateOne({ _id: podA._id }, { $addToSet: { members: bot._id } });
    const claim = await request(app).post(`/api/tasks/${podA._id}/TASK-546/claim`)
      .set('Authorization', 'Bearer cm_agent_settings_claim_fixture');
    expect(claim.status).toBe(200);
    expect((await Task.findOne({ podId: podA._id, taskId: 'TASK-546' })).claimedBy).toBe(String(bot._id));
    if (claimForm === 'instance-id claim') {
      await Task.updateOne({ podId: podA._id, taskId: 'TASK-546' }, { $set: { claimedBy: 'same' } });
    }
    const url = '/api/registry/agents/settings-agent/manage-settings?instanceId=same';
    const member = await request(app).get(url).set('Authorization', `Bearer ${token(owner)}`);
    expect(member.body.heldTask).toEqual({ taskId: 'TASK-546', podId: String(podA._id), podName: 'Settings A' });
    expect(JSON.stringify(member.body.heldTask)).not.toContain('Private title');
    // Keep memberPodIds nonempty: an all-or-nothing empty-list guard must not
    // stand in for filtering each claimed task's own pod.
    await Pod.updateOne({ _id: podB._id }, { $addToSet: { members: admin._id } });
    expect((await Pod.findById(podA._id)).members.map(String)).not.toContain(String(admin._id));
    const outsider = await request(app).get(url).set('Authorization', `Bearer ${token(admin)}`);
    expect(outsider.status).toBe(200);
    expect(outsider.body.installations.map((entry) => entry.podId)).toContain(String(podB._id));
    expect(outsider.body.heldTask).toBeNull();
    await Pod.updateOne({ _id: podB._id }, { $pull: { members: admin._id } });
    await Task.deleteMany({ taskId: 'TASK-546' });
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

  it('does not present a standalone CLI preference as a running effort', async () => {
    await AgentInstallation.updateOne({ podId: podA._id, agentName: 'settings-agent' }, {
      $set: { 'config.environment': { model: 'opus', effort: 'max' } },
    });
    const response = await request(app)
      .get('/api/registry/agents/settings-agent/manage-settings?instanceId=same')
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect(response.body.runtimeManaged).toBe(false);
    expect(response.body.runtimeEditable).toBe(false);
    expect(response.body.runtimeControls.effort).toBe('');
    expect(response.body.runtimeSavedControls.effort).toBe('max');
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
});
