/**
 * D115 — GET /api/agents/health (docs/architecture/fleet-health.md).
 *
 * Real Mongo (tier 1). Pins the three rules of the design note: the pod set is
 * the viewer's own memberships (no admin bypass, no co-member agent-dm), every
 * count is filtered to installs in those pods before grouping, and the
 * response is an allowlist that never carries message text.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent');
const AgentRun = require('../../models/AgentRun');
const AgentRuntimeObservation = require('../../models/AgentRuntimeObservation');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { resolveWindow, eventOutcome } = require('../../services/agentHealthService');

const healthRoutes = require('../../routes/agentHealth');

const JWT_SECRET = 'test-jwt-secret-for-agent-health';
const SECRET = 'SECRET-MESSAGE-TEXT';

jest.setTimeout(60000);

describe('GET /api/agents/health', () => {
  let app;
  let viewer; let stranger; let globalAdmin; let botUser;
  let shared; let otherPod; let dmPod;
  const token = (user) => jwt.sign({ id: user._id.toString() }, JWT_SECRET);

  const install = (agentName, podId, runtime, extra = {}) => AgentInstallation.create({
    agentName,
    podId,
    instanceId: 'default',
    version: '1.0.0',
    installedBy: viewer._id,
    status: 'active',
    config: { runtime, note: SECRET },
    ...extra,
  });
  const event = (agentName, podId, type, status, outcome, extra = {}) => AgentEvent.create({
    agentName,
    instanceId: 'default',
    podId,
    type,
    status,
    payload: { content: SECRET },
    ...(outcome ? { delivery: { outcome, reason: SECRET, details: { reply: SECRET } } } : {}),
    ...extra,
  });

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/agents/health', healthRoutes);

    viewer = await User.create({ username: 'health-viewer', email: 'hv@test.com', password: 'password123' });
    stranger = await User.create({ username: 'health-stranger', email: 'hs@test.com', password: 'password123' });
    globalAdmin = await User.create({
      username: 'health-admin', email: 'ha@test.com', password: 'password123', role: 'admin', 
    });
    botUser = await User.create({
      username: 'scribe-bot',
      email: 'scribe@test.com',
      password: 'password123',
      isBot: true,
      botMetadata: { agentName: 'scribe', instanceId: 'default' },
    });

    shared = await Pod.create({
      name: 'Launch prep', type: 'chat', createdBy: viewer._id, members: [viewer._id, stranger._id], 
    });
    otherPod = await Pod.create({
      name: 'Not yours', type: 'chat', createdBy: stranger._id, members: [stranger._id], 
    });
    // The leak case: scribe shares a pod with the viewer, and has a DM with a
    // third agent that the viewer isn't a member of.
    dmPod = await Pod.create({
      name: 'scribe + ghost', type: 'agent-dm', createdBy: stranger._id, members: [stranger._id], 
    });

    await install('otter', shared._id, { runtimeType: 'native' });
    await install('scribe', shared._id, { host: 'byo', runtimeType: 'local-cli' });
    await install('gone', shared._id, { runtimeType: 'native' }, { status: 'uninstalled' });
    await install('ghost', otherPod._id, { runtimeType: 'native' });
    await install('scribe', dmPod._id, { host: 'byo', runtimeType: 'local-cli' });

    // otter, asked wakes: one per outcome.
    await event('otter', shared._id, 'chat.mention', 'acked', 'posted');
    await event('otter', shared._id, 'chat.mention', 'acked', 'no_action');
    await event('otter', shared._id, 'message.posted', 'acked', 'skipped');
    await event('otter', shared._id, 'chat.mention', 'acked', 'error');
    await event('otter', shared._id, 'chat.mention', 'failed', null);
    await event('otter', shared._id, 'chat.mention', 'expired', null);
    await event('otter', shared._id, 'chat.mention', 'pending', null);
    await event('otter', shared._id, 'chat.mention', 'delivered', null);
    await event('otter', shared._id, 'task.assigned', 'acked', 'posted');
    // otter, heartbeats and a digest.
    await event('otter', shared._id, 'heartbeat', 'acked', 'no_action');
    await event('otter', shared._id, 'heartbeat', 'acked', 'posted');
    await event('otter', shared._id, 'chat.mention', 'acked', 'posted', { deliveryMode: 'digest' });
    // Out of the window.
    await event('otter', shared._id, 'chat.mention', 'acked', 'posted', { createdAt: new Date(Date.now() - 30 * 3600 * 1000) });
    // Not the viewer's: another pod, an uninstalled agent, scribe's DM.
    await event('ghost', otherPod._id, 'chat.mention', 'acked', 'posted');
    await event('gone', shared._id, 'chat.mention', 'acked', 'posted');
    await event('scribe', dmPod._id, 'chat.mention', 'acked', 'posted');
    await event('scribe', dmPod._id, 'chat.mention', 'acked', 'posted');
    // scribe in the shared pod.
    await event('scribe', shared._id, 'chat.mention', 'failed', null);
    // A turn that printed nothing: the CLI acks no_action with reason 'empty-output'.
    // It is empty, never a decline.
    await event('scribe', shared._id, 'chat.mention', 'acked', 'no_action', { delivery: { outcome: 'no_action', reason: 'empty-output' } });

    await AgentRun.create({
      podId: shared._id,
      agentName: 'otter',
      instanceId: 'default',
      trigger: 'mention',
      status: 'succeeded',
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
      totalTokens: 1000,
      sandboxSeconds: 30,
      turns: [{ turnIndex: 0, model: 'm', llmResponseText: SECRET }],
    });
    await AgentRun.create({
      podId: shared._id,
      agentName: 'otter',
      instanceId: 'default',
      trigger: 'mention',
      status: 'succeeded',
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      totalTokens: 200,
      emptyCompletion: true,
    });
    await AgentRun.create({
      podId: shared._id,
      agentName: 'otter',
      instanceId: 'default',
      trigger: 'first_contact',
      status: 'failed',
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
      errorKind: 'config',
      errorMessage: SECRET,
    });
    // heron: a config failure, then a clean run. The latest finished run decides
    // needs-you, so the fixed config is a count in errorKinds, not an action.
    await install('heron', shared._id, { runtimeType: 'native' });
    await AgentRun.create({
      podId: shared._id, agentName: 'heron', instanceId: 'default', trigger: 'mention', status: 'failed', errorKind: 'config', startedAt: new Date(Date.now() - 15 * 60 * 1000),
    });
    await AgentRun.create({
      podId: shared._id, agentName: 'heron', instanceId: 'default', trigger: 'mention', status: 'succeeded', startedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    await AgentRun.create({
      podId: dmPod._id, agentName: 'scribe', instanceId: 'default', trigger: 'mention', status: 'succeeded', totalTokens: 999,
    });

    await AgentRuntimeObservation.create({
      agentUserId: botUser._id,
      machineId: 'mac-1',
      connectedAt: new Date(),
      lastSeenAt: new Date(Date.now() - 60 * 60 * 1000),
      lastSpawnOutcome: 'failed',
      lastSpawnFailure: 'claude-signed-out',
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  it('counts each outcome for an install in the viewer\'s pod', async () => {
    const res = await request(app).get('/api/agents/health').set('Authorization', `Bearer ${token(viewer)}`);
    expect(res.status).toBe(200);
    const otter = res.body.agents.find((row) => row.agentName === 'otter');
    expect(otter.runtime).toBe('hosted');
    expect(otter.asked).toEqual({
      total: 9, posted: 2, declined: 2, empty: 0, failed: 2, expired: 1, acknowledged: 0, inFlight: 2, 
    });
    expect(otter.heartbeats).toMatchObject({ total: 2, posted: 1, declined: 1 });
    expect(otter.digests).toBe(1);
    expect(otter.kinds).toMatchObject({ mention: 7, chat: 1, heartbeat: 2 });
    expect(otter.otherKinds).toEqual({ 'task.assigned': 1 });
    expect(otter.runs).toMatchObject({
      total: 3, succeeded: 2, failed: 1, empty: 1, meteredTurns: 2, totalTokens: 1200, sandboxSeconds: 30, errorKinds: { config: 1 },
    });
    expect(otter.needsYou).toBe('config');
    // A config failure the agent has since run cleanly past keeps its count but asks nothing.
    const heron = res.body.agents.find((row) => row.agentName === 'heron');
    expect(heron.runs.errorKinds).toEqual({ config: 1 });
    expect(heron.needsYou).toBeNull();
  });

  it('reads BYO liveness and its fixed failure code', async () => {
    const res = await request(app).get('/api/agents/health').set('Authorization', `Bearer ${token(viewer)}`);
    const scribe = res.body.agents.filter((row) => row.agentName === 'scribe');
    expect(scribe).toHaveLength(1);
    expect(scribe[0].pod.id).toBe(String(shared._id));
    expect(scribe[0].runtime).toBe('byo');
    expect(scribe[0].liveness).toMatchObject({ online: false, turnRunning: false, lastSpawnFailure: 'claude-signed-out' });
    expect(scribe[0].needsYou).toBe('claude-signed-out');
    // The two posted DM wakes and the DM run are not the viewer's.
    expect(scribe[0].asked).toMatchObject({
      total: 2, failed: 1, empty: 1, declined: 0, posted: 0, 
    });
    expect(scribe[0].runs).toBeNull();
  });

  it('never lists another pod\'s agent, an uninstalled one, or a co-member\'s agent-dm', async () => {
    const res = await request(app).get('/api/agents/health').set('Authorization', `Bearer ${token(viewer)}`);
    const names = res.body.agents.map((row) => `${row.agentName}@${row.pod.id}`);
    expect(names.sort()).toEqual([`heron@${shared._id}`, `otter@${shared._id}`, `scribe@${shared._id}`].sort());
  });

  it('gives a global admin who is a member of nothing an empty list', async () => {
    const res = await request(app).get('/api/agents/health').set('Authorization', `Bearer ${token(globalAdmin)}`);
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
  });

  it('never returns message text or free-text fields', async () => {
    const res = await request(app).get('/api/agents/health').set('Authorization', `Bearer ${token(viewer)}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SECRET);
    // `config` isn't listed: `errorKinds` legitimately carries the code `config`.
    // The install's own config is seeded with SECRET above, so the first check covers it.
    ['payload', 'reason', 'errorMessage', 'details', 'error', 'args', 'result', 'turns'].forEach((field) => {
      expect(body).not.toMatch(new RegExp(`"${field}"\\s*:`));
    });
  });

  it('refuses an agent\'s own account', async () => {
    const res = await request(app).get('/api/agents/health').set('Authorization', `Bearer ${token(botUser)}`);
    // The auth middleware or the route's own isBot check refuses it; either way
    // no counts come back.
    expect(res.status).toBe(403);
    expect(res.body.agents).toBeUndefined();
  });

  it('honours an offered window and widens the count', async () => {
    const res = await request(app).get('/api/agents/health?window=72h').set('Authorization', `Bearer ${token(viewer)}`);
    expect(res.body.window.hours).toBe(72);
    const otter = res.body.agents.find((row) => row.agentName === 'otter');
    expect(otter.asked.total).toBe(10);
  });
});

describe('agent health helpers', () => {
  it('defaults to min(24h, retention) and never offers a window retention misses', () => {
    expect(resolveWindow(undefined, 168)).toEqual({ hours: 24, retentionHours: 168, options: [24, 72, 168] });
    expect(resolveWindow('168h', 168).hours).toBe(168);
    expect(resolveWindow('500h', 168).hours).toBe(24);
    expect(resolveWindow(undefined, 12)).toEqual({ hours: 12, retentionHours: 12, options: [12] });
    expect(resolveWindow('72h', 48)).toEqual({ hours: 24, retentionHours: 48, options: [24] });
    // The default bound is the shorter of the delivered and failed retentions.
    const saved = { d: process.env.AGENT_EVENT_DELIVERED_RETENTION_HOURS, f: process.env.AGENT_EVENT_FAILED_RETENTION_HOURS };
    process.env.AGENT_EVENT_DELIVERED_RETENTION_HOURS = '168';
    process.env.AGENT_EVENT_FAILED_RETENTION_HOURS = '48';
    try { expect(resolveWindow('72h').retentionHours).toBe(48); } finally {
      if (saved.d === undefined) delete process.env.AGENT_EVENT_DELIVERED_RETENTION_HOURS; else process.env.AGENT_EVENT_DELIVERED_RETENTION_HOURS = saved.d;
      if (saved.f === undefined) delete process.env.AGENT_EVENT_FAILED_RETENTION_HOURS; else process.env.AGENT_EVENT_FAILED_RETENTION_HOURS = saved.f;
    }
  });

  it('maps every status and outcome, keeping in-flight apart from failed', () => {
    expect(eventOutcome('acked', 'posted')).toBe('posted');
    expect(eventOutcome('acked', 'no_action')).toBe('declined');
    expect(eventOutcome('acked', 'no_action', true)).toBe('empty');
    expect(eventOutcome('acked', 'skipped')).toBe('declined');
    expect(eventOutcome('acked', 'error')).toBe('failed');
    expect(eventOutcome('failed', null)).toBe('failed');
    expect(eventOutcome('expired', null)).toBe('expired');
    expect(eventOutcome('acked', 'acknowledged')).toBe('acknowledged');
    expect(eventOutcome('acked', null)).toBe('acknowledged');
    ['pending', 'folding', 'delivered'].forEach((status) => expect(eventOutcome(status, null)).toBe('inFlight'));
  });
});
