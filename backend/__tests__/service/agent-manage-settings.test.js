const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentMemory = require('../../models/AgentMemory');
const manageSettings = require('../../routes/registry/manage-settings');
const podAgents = require('../../routes/registry/pod-agents');

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
});
