// Real models and the real route, because the claim is the round trip through
// `config`, a Map: a schedule saved by the route, found by the dispatcher's
// dotted query, and claimed once per day.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const mockEnqueue = jest.fn();
jest.mock('../../services/agentEventService', () => ({ enqueue: (...args) => mockEnqueue(...args) }));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { dispatchSchedules } = require('../../services/agentScheduleService');
const manageSettings = require('../../routes/registry/manage-settings');

const SECRET = 'agent-schedule-test';
const AT = new Date('2026-11-07T15:50:00Z');
const body = {
  enabled: true, time: '07:47', timezone: 'America/Los_Angeles', prompt: '  Post the morning count.  ',
};

describe('a BYO agent schedule', () => {
  let app; let owner; let other; let pod;
  const header = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;
  const seat = (agentName, runtime = { runtimeType: 'local-cli', host: 'byo' }, installedBy = owner._id, extra = {}) => (
    AgentInstallation.create({
      agentName, instanceId: 'default', podId: pod._id, version: '1', installedBy, status: 'active',
      config: new Map([['runtime', runtime]]), ...extra,
    })
  );
  const save = (agentName, user = owner, payload = body) => request(app)
    .put(`/api/registry/agents/${agentName}/manage-settings/pods/${pod._id}/schedule`)
    .set('Authorization', header(user))
    .send(payload);

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', manageSettings);
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    mockEnqueue.mockReset();
    mockEnqueue.mockResolvedValue({});
    owner = await User.create({ username: 'sched-owner', email: 'o@test.com', password: 'password123' });
    other = await User.create({ username: 'sched-other', email: 'x@test.com', password: 'password123' });
    pod = await Pod.create({ name: 'Ops', type: 'chat', createdBy: owner._id, members: [owner._id] });
  });

  it('saves through the route and fires once on its day, with the heartbeat off', async () => {
    await seat('daily');
    const res = await save('daily');
    expect(res.status).toBe(200);
    expect(res.body.settings.schedule).toEqual({
      enabled: true, time: '07:47', timezone: 'America/Los_Angeles', prompt: 'Post the morning count.',
    });
    expect(res.body.settings.heartbeatEnabled).toBe(false);

    await expect(dispatchSchedules(AT)).resolves.toBe(1);
    const event = mockEnqueue.mock.calls[0][0];
    expect(event).toEqual(expect.objectContaining({ agentName: 'daily', type: 'heartbeat' }));
    expect(String(event.podId)).toBe(String(pod._id));
    expect(event.payload.trigger).toBe('schedule');
    expect(event.payload.content).toContain('Post the morning count.');

    await expect(dispatchSchedules(new Date(AT.getTime() + 10 * 60 * 1000))).resolves.toBe(0);
    await expect(dispatchSchedules(new Date(AT.getTime() + 24 * 60 * 60 * 1000))).resolves.toBe(1);
  });

  it('two dispatchers at once fire it once', async () => {
    await seat('race');
    await save('race');
    const fired = await Promise.all([dispatchSchedules(AT), dispatchSchedules(AT)]);
    expect(fired[0] + fired[1]).toBe(1);
  });

  it('a re-save keeps the day already fired', async () => {
    await seat('resave');
    await save('resave');
    await dispatchSchedules(AT);
    await save('resave', owner, { ...body, prompt: 'New words' });
    await expect(dispatchSchedules(AT)).resolves.toBe(0);
  });

  it('skips a schedule turned off and a seat that left', async () => {
    await seat('off');
    await save('off', owner, { ...body, enabled: false });
    const left = await seat('left');
    await save('left');
    await AgentInstallation.updateOne({ _id: left._id }, { status: 'uninstalled' });
    await expect(dispatchSchedules(AT)).resolves.toBe(0);
  });

  it.each([
    ['hosted', { runtimeType: 'hosted' }],
    ['native', { runtimeType: 'native' }],
  ])('refuses a %s agent, and skips one written some other way', async (_label, runtime) => {
    await seat('hosted', runtime);
    const res = await save('hosted');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('schedule_byo_only');
    await AgentInstallation.collection.updateOne(
      { agentName: 'hosted' },
      { $set: { 'config.schedule': { enabled: true, time: '07:47', timezone: 'America/Los_Angeles', prompt: 'x' } } },
    );
    await expect(dispatchSchedules(AT)).resolves.toBe(0);
  });

  it('refuses someone who did not install it, and a bad body', async () => {
    await seat('theirs');
    expect((await save('theirs', other)).status).toBe(403);
    const bad = await save('theirs', owner, { ...body, time: 'soon' });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('time');
    expect((await save('nobody')).status).toBe(404);
  });

  it('a stored bad timezone costs that row, not the pass', async () => {
    await seat('broken');
    await AgentInstallation.collection.updateOne(
      { agentName: 'broken' },
      { $set: { 'config.schedule': { enabled: true, time: '07:47', timezone: 'Nope/Nope', prompt: 'x' } } },
    );
    await seat('fine');
    await save('fine');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(dispatchSchedules(AT)).resolves.toBe(1);
    warn.mockRestore();
  });

  it('a failed enqueue costs that row, not the pass', async () => {
    await seat('fails');
    await save('fails');
    await seat('works');
    await save('works');
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockEnqueue.mockRejectedValueOnce(new Error('queue down'));
    await expect(dispatchSchedules(AT)).resolves.toBe(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

