// F298: "@nova" sent while nova was stopped. The room's line says it can't answer
// until its owner starts it, so a Start an hour later has to answer, and a mention
// too old to answer has to say so rather than close in silence.
process.env.PG_HOST = '';
jest.mock('../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));
jest.mock('../../services/agentWebSocketService', () => ({ pushEvent: jest.fn() }));
jest.mock('../../services/agentDigestFoldService', () => ({
  readFoldedDigest: jest.fn().mockResolvedValue(null),
  settleFoldedDigest: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/unansweredMentionService', () => ({
  ...jest.requireActual('../../services/unansweredMentionService'),
  noteUnansweredMention: jest.fn(),
}));
const mongoose = require('mongoose');
const AgentEvent = require('../../models/AgentEvent');
const Service = require('../../services/agentEventService');
const { runAgent } = require('../../services/nativeRuntimeService');
const { noteUnansweredMention } = require('../../services/unansweredMentionService');
const {
  setupMongoDb, clearMongoDb, closeMongoDb, waitFor,
} = require('../utils/testUtils');

const podId = new mongoose.Types.ObjectId();
const install = {
  agentName: 'clerk', instanceId: 'default', runtimeType: 'internal', podId,
};
const HOUR = 60 * 60 * 1000;
const success = { status: 'succeeded', runId: 'run-1', totalTurns: 1 };
const waiting = (ageMs, overrides = {}) => AgentEvent.create({
  agentName: 'clerk',
  instanceId: 'default',
  podId,
  type: 'chat.mention',
  payload: { content: '@clerk hello', userId: 'a'.repeat(24), messageId: '900' },
  status: 'pending',
  createdAt: new Date(Date.now() - ageMs),
  ...overrides,
});
const statusOf = async (event) => (await AgentEvent.findById(event._id).lean()).status;
const start = () => Service.rescuePendingForIdentity('clerk', 'default');

beforeAll(setupMongoDb);
beforeEach(async () => {
  Service.inProcessDraining = false;
  Service.inProcessDrain = undefined;
  Service.inProcessWork.clear();
  Service.inProcessRunning.clear();
  Service.inProcessLanes?.clear();
  Service.inProcessLaneHolders?.clear();
  jest.clearAllMocks();
  await clearMongoDb();
  jest.spyOn(Service, 'resolveInProcessInstallation').mockResolvedValue(install);
  jest.spyOn(Service, 'inProcessEventTargets').mockResolvedValue([{ agentName: 'clerk', instanceId: 'default', podId }]);
  runAgent.mockResolvedValue(success);
  noteUnansweredMention.mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeMongoDb);

describe('a Start', () => {
  it('runs a mention that waited through an hour of being stopped', async () => {
    const event = await waiting(HOUR);
    expect(await start()).toMatchObject({ rescued: 1, closed: 0 });
    await waitFor(() => runAgent.mock.calls.length === 1);
    expect(noteUnansweredMention).not.toHaveBeenCalled();
    await waitFor(() => Service.inProcessWork.size === 0);
    expect(await statusOf(event)).toBe('acked');
  });

  it('still runs one just under a day old', async () => {
    await waiting(23 * HOUR);
    expect(await start()).toMatchObject({ rescued: 1, closed: 0 });
    await waitFor(() => Service.inProcessWork.size === 0);
  });

  it('closes one past a day and tells the person it went unanswered', async () => {
    const event = await waiting(25 * HOUR);
    expect(await start()).toMatchObject({ rescued: 0, closed: 1 });
    expect(await statusOf(event)).toBe('failed');
    expect(noteUnansweredMention).toHaveBeenCalledTimes(1);
    expect(String(noteUnansweredMention.mock.calls[0][0]._id)).toBe(String(event._id));
    expect(noteUnansweredMention.mock.calls[0][0].status).toBe('failed');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('closes a kernel wake past a day with no line, since nobody is waiting on it', async () => {
    const event = await waiting(25 * HOUR, { type: 'heartbeat' });
    expect(await start()).toMatchObject({ rescued: 0, closed: 1 });
    expect(await statusOf(event)).toBe('failed');
    expect(noteUnansweredMention).not.toHaveBeenCalled();
  });

  it('keeps a failed line from reopening what it closed', async () => {
    noteUnansweredMention.mockRejectedValue(new Error('pg down'));
    const event = await waiting(25 * HOUR);
    expect(await start()).toMatchObject({ closed: 1 });
    expect(await statusOf(event)).toBe('failed');
  });

  it('counts a row another replica closed first as theirs, with no second line', async () => {
    const event = await waiting(25 * HOUR);
    const realFind = AgentEvent.find.bind(AgentEvent);
    jest.spyOn(AgentEvent, 'find').mockImplementationOnce((...args) => {
      const query = realFind(...args);
      const lean = query.lean.bind(query);
      query.lean = () => lean().then(async (rows) => {
        await AgentEvent.updateOne({ _id: event._id }, { $set: { status: 'failed' } });
        return rows;
      });
      return query;
    });
    expect(await start()).toMatchObject({ closed: 0 });
    expect(noteUnansweredMention).not.toHaveBeenCalled();
  });

  it('leaves a digest row alone however old', async () => {
    const event = await waiting(25 * HOUR, { deliveryMode: 'digest' });
    expect(await start()).toEqual({ rescued: 0, closed: 0 });
    expect(await statusOf(event)).toBe('pending');
  });
});

describe('a Start with more waiting than it can run', () => {
  const many = (count, ageMs, overrides) => Promise.all(
    Array.from({ length: count }, () => waiting(ageMs, overrides)),
  );

  it('answers the person ahead of older wakes nobody is waiting on', async () => {
    await many(60, 20 * HOUR, { type: 'message.posted' });
    const event = await waiting(HOUR);
    expect(await start()).toMatchObject({ rescued: 1, closed: 60 });
    await waitFor(() => Service.inProcessWork.size === 0);
    expect(await statusOf(event)).toBe('acked');
  });

  it('answers the person ahead of newer wakes that fill the batch', async () => {
    await many(60, 20 * 60 * 1000, { type: 'message.posted' });
    const event = await waiting(60 * 1000);
    expect(await start()).toMatchObject({ rescued: 50, closed: 0 });
    await waitFor(() => Service.inProcessWork.size === 0);
    expect(await statusOf(event)).toBe('acked');
  });

  it('runs no more than the batch when people alone fill it', async () => {
    await many(50, HOUR);
    await many(5, 20 * 60 * 1000, { type: 'message.posted' });
    expect(await start()).toMatchObject({ rescued: 50, closed: 0 });
    await waitFor(() => Service.inProcessWork.size === 0);
    expect(await AgentEvent.countDocuments({ type: 'message.posted', status: 'pending' })).toBe(5);
  });

  it('gives a kernel wake the half hour, since nobody is waiting on it', async () => {
    const event = await waiting(2 * HOUR, { payload: { content: 'task assigned', triggerAuthor: 'kernel' } });
    expect(await start()).toMatchObject({ rescued: 0, closed: 1 });
    expect(await statusOf(event)).toBe('failed');
    expect(noteUnansweredMention).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('runs a thread mention and a DM the same as a pod mention', async () => {
    const thread = await waiting(HOUR, { type: 'thread.mention' });
    const dm = await waiting(HOUR, { type: 'dm.message' });
    expect(await start()).toMatchObject({ rescued: 2, closed: 0 });
    await waitFor(() => Service.inProcessWork.size === 0);
    expect(await statusOf(thread)).toBe('acked');
    expect(await statusOf(dm)).toBe('acked');
  });

  it('leaves mentions past the line batch for the next pass, so each person is still told', async () => {
    await many(60, 25 * HOUR);
    expect(await start()).toMatchObject({ rescued: 0, closed: 50 });
    expect(noteUnansweredMention).toHaveBeenCalledTimes(50);
    expect(await AgentEvent.countDocuments({ status: 'pending' })).toBe(10);

    expect(await start()).toMatchObject({ rescued: 0, closed: 10 });
    expect(noteUnansweredMention).toHaveBeenCalledTimes(60);
  });
});

describe('the sweep', () => {
  const sweep = () => Service.rescueStrandedPendingInProcess(new Date(), 5);

  it('keeps its half hour: a reply that late is no longer an answer', async () => {
    const event = await waiting(HOUR);
    expect(await sweep()).toMatchObject({ rescued: 0, closed: 1 });
    expect(await statusOf(event)).toBe('failed');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('tells the person, where a close used to say nothing', async () => {
    await waiting(HOUR);
    await sweep();
    expect(noteUnansweredMention).toHaveBeenCalledTimes(1);
  });

  it('still runs a mention inside the half hour', async () => {
    await waiting(10 * 60 * 1000);
    expect(await sweep()).toMatchObject({ rescued: 1, closed: 0 });
    await waitFor(() => Service.inProcessWork.size === 0);
  });
});
