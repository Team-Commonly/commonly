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
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');
const DMService = require('../../services/dmService');
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
  const save = (agentName, user = owner, payload = body, podId = pod._id) => request(app)
    .put(`/api/registry/agents/${agentName}/manage-settings/pods/${podId}/schedule`)
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
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('a re-save keeps the day already fired', async () => {
    await seat('resave');
    await save('resave');
    await dispatchSchedules(AT);
    await save('resave', owner, { ...body, prompt: 'New words' });
    await expect(dispatchSchedules(AT)).resolves.toBe(0);
  });

  it('stays on the row it was set on when a guest opens a room with the agent', async () => {
    const bot = await User.create({
      username: 'daily-bot', email: 'b@test.com', password: 'password123', isBot: true,
      botMetadata: { agentName: 'daily', instanceId: 'default' },
    });
    await seat('daily');
    await save('daily');
    const room = await DMService.getOrCreateAgentRoom(bot._id, other._id, { agentName: 'daily', instanceId: 'default' });
    const roomRow = await AgentInstallation.findOne({ agentName: 'daily', podId: room._id }).lean();
    expect(String(roomRow.installedBy)).toBe(String(other._id));
    expect(roomRow.config.runtime).toBeDefined();
    expect(roomRow.config.schedule).toBeUndefined();
    expect(await dispatchSchedules(AT)).toBe(1);
    expect(String(mockEnqueue.mock.calls[0][0].podId)).toBe(String(pod._id));
  });

  it.each([['install'], ['upsert']])('%s never stores a schedule copied from another row', async (method) => {
    const schedule = { enabled: true, time: '07:47', timezone: 'America/Los_Angeles', prompt: 'x' };
    const runtime = { runtimeType: 'local-cli' };
    const options = { version: '1', installedBy: other._id };
    const first = await AgentInstallation[method]('copy-a', pod._id, { ...options, config: new Map(Object.entries({ runtime, schedule })) });
    const second = await AgentInstallation[method]('copy-b', pod._id, { ...options, config: { runtime, schedule } });
    [first, second].forEach((row) => {
      expect(row.config.get('schedule')).toBeUndefined();
      expect(row.config.get('runtime')).toEqual(runtime);
    });
  });

  it('refuses a guest whose row names them, and a second installer', async () => {
    const bot = await User.create({
      username: 'room-bot', email: 'r@test.com', password: 'password123', isBot: true,
      botMetadata: { agentName: 'roomed', instanceId: 'default' },
    });
    await seat('roomed');
    const room = await DMService.getOrCreateAgentRoom(bot._id, other._id, { agentName: 'roomed', instanceId: 'default' });
    const res = await save('roomed', other, body, room._id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_installation_missing');

    const elsewhere = await Pod.create({ name: 'Theirs', type: 'chat', createdBy: other._id, members: [other._id] });
    await AgentInstallation.create({
      agentName: 'roomed', instanceId: 'default', podId: elsewhere._id, version: '1', installedBy: other._id,
      status: 'active', config: new Map([['runtime', { runtimeType: 'local-cli', host: 'byo' }]]),
    });
    expect((await save('roomed', other, body, elsewhere._id)).body.code).toBe('another_installer');
  });

  it('needs a seat in the pod to start a schedule, not to stop one', async () => {
    await seat('left');
    expect((await save('left')).status).toBe(200);
    await Pod.updateOne({ _id: pod._id }, { $pull: { members: owner._id } });
    const res = await save('left');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_pod_member');
    expect((await save('left', owner, { ...body, enabled: false })).status).toBe(200);
  });

  it.each([
    ['a mention wrote another pod\'s row', async () => {
      const elsewhere = await Pod.create({ name: 'Theirs', type: 'chat', createdBy: other._id, members: [other._id] });
      await AgentInstallation.upsert('stopped', elsewhere._id, { version: '1', installedBy: other._id });
    }],
    ['their own row is paused', () => AgentInstallation.updateOne({ agentName: 'stopped' }, { status: 'paused' })],
  ])('lets the owner stop it when %s, and changes nothing else', async (_name, lockOut) => {
    await seat('stopped');
    await save('stopped');
    await lockOut();
    expect((await save('stopped')).status).toBe(403);
    const res = await save('stopped', owner, { ...body, enabled: false, prompt: 'Something else.', time: '09:00' });
    expect(res.status).toBe(200);
    const row = await AgentInstallation.findOne({ agentName: 'stopped', podId: pod._id }).lean();
    expect(row.config.schedule).toMatchObject({ enabled: false, prompt: 'Post the morning count.', time: '07:47' });
  });

  it('stops on enabled alone and keeps the rest', async () => {
    await seat('bare');
    await save('bare');
    expect((await save('bare', owner, { enabled: false })).status).toBe(200);
    const row = await AgentInstallation.findOne({ agentName: 'bare' }).lean();
    expect(row.config.schedule).toMatchObject({ enabled: false, prompt: 'Post the morning count.', time: '07:47' });
  });

  it('won\'t write a bare stop where no schedule exists', async () => {
    await seat('none');
    const res = await save('none', owner, { enabled: false });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_schedule');
    const row = await AgentInstallation.findOne({ agentName: 'none' }).lean();
    expect(row.config.schedule).toBeUndefined();
  });

  it('tells someone without rights nothing about whether a schedule exists', async () => {
    await seat('quiet');
    expect((await save('quiet', other, { enabled: false })).status).toBe(403);
    await save('quiet');
    expect((await save('quiet', other, { enabled: false })).status).toBe(403);
  });

  it('still needs every field to start one', async () => {
    await seat('half');
    expect((await save('half', owner, { enabled: true })).status).toBe(400);
  });

  it('gives a guest nothing to stop on their own room row', async () => {
    const bot = await User.create({
      username: 'empty-bot', email: 'e@test.com', password: 'password123', isBot: true,
      botMetadata: { agentName: 'emptied', instanceId: 'default' },
    });
    await seat('emptied');
    const room = await DMService.getOrCreateAgentRoom(bot._id, other._id, { agentName: 'emptied', instanceId: 'default' });
    expect((await save('emptied', other, { ...body, enabled: false }, room._id)).status).toBe(403);
    const row = await AgentInstallation.findOne({ agentName: 'emptied', podId: room._id }).lean();
    expect(row.config.schedule).toBeUndefined();
  });

  it('leaves the schedule alone on a refusal', async () => {
    await seat('kept');
    await save('kept');
    const before = (await AgentInstallation.findOne({ agentName: 'kept' }).lean()).config.schedule;
    expect((await save('kept', other, { ...body, prompt: 'Not yours.' })).status).toBe(403);
    expect((await save('kept', owner, { ...body, time: '25:00' })).status).toBe(400);
    expect((await AgentInstallation.findOne({ agentName: 'kept' }).lean()).config.schedule).toEqual(before);
  });

  it('keeps a day claimed while a save was on its way', async () => {
    await seat('racing');
    await save('racing');
    const stale = await AgentInstallation.findOne({ agentName: 'racing' });
    const findOne = jest.spyOn(AgentInstallation, 'findOne').mockResolvedValueOnce(stale);
    await dispatchSchedules(AT);
    await save('racing', owner, { ...body, prompt: 'A new job.' });
    findOne.mockRestore();
    const row = await AgentInstallation.findOne({ agentName: 'racing' }).lean();
    expect(row.config.schedule).toMatchObject({ prompt: 'A new job.', lastFiredOn: '2026-11-07' });
  });

  it('claims only the schedule it read', async () => {
    await seat('changed');
    await save('changed');
    const rows = await AgentInstallation.find({ agentName: 'changed' }).lean();
    await save('changed', owner, { ...body, enabled: false });
    const find = jest.spyOn(AgentInstallation, 'find')
      .mockReturnValueOnce({ select: () => ({ lean: async () => rows }) });
    expect(await dispatchSchedules(AT)).toBe(0);
    find.mockRestore();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('saves on a row from before instance ids were stored', async () => {
    await AgentInstallation.collection.insertOne({
      agentName: 'legacy', podId: pod._id, version: '1', installedBy: owner._id, status: 'active',
      config: { runtime: { runtimeType: 'local-cli', host: 'byo' } },
    });
    expect((await save('legacy')).status).toBe(200);
    expect(await dispatchSchedules(AT)).toBe(1);
    expect(mockEnqueue.mock.calls[0][0].instanceId).toBe('default');
  });

  it('hands the day back when the enqueue fails, and the next tick fires it', async () => {
    await seat('retried');
    await save('retried');
    jest.spyOn(console, 'error').mockImplementationOnce(() => {});
    mockEnqueue.mockRejectedValueOnce(new Error('queue down'));
    expect(await dispatchSchedules(AT)).toBe(0);
    const row = await AgentInstallation.findOne({ agentName: 'retried' }).lean();
    expect(row.config.schedule.lastFiredOn).toBeUndefined();
    expect(await dispatchSchedules(new Date(AT.getTime() + 60 * 1000))).toBe(1);
  });

  it('does not add to a wake the seat has not picked up, and spends the day', async () => {
    await seat('offline');
    await save('offline');
    await AgentEvent.create({
      agentName: 'offline', instanceId: 'default', podId: pod._id, type: 'heartbeat', status: 'pending',
      payload: { trigger: 'schedule', content: 'yesterday' },
    });
    expect(await dispatchSchedules(AT)).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
    const row = await AgentInstallation.findOne({ agentName: 'offline' }).lean();
    expect(row.config.schedule.lastFiredOn).toBe('2026-11-07');
    expect(row.config.schedule.lastFiredAt).toBeUndefined();
  });

  it('waits behind no plain heartbeat, and stands down with autonomy off', async () => {
    await seat('beating');
    await save('beating');
    await AgentEvent.create({
      agentName: 'beating', instanceId: 'default', podId: pod._id, type: 'heartbeat', status: 'pending', payload: {},
    });
    await seat('quiet');
    await save('quiet');
    await AgentInstallation.updateOne({ agentName: 'quiet' }, { $set: { 'config.autonomy': { enabled: false } } });
    expect(await dispatchSchedules(AT)).toBe(1);
    expect(mockEnqueue.mock.calls[0][0].agentName).toBe('beating');
    const fired = await AgentInstallation.findOne({ agentName: 'beating' }).lean();
    expect(fired.config.schedule.lastFiredAt).toEqual(AT);
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

