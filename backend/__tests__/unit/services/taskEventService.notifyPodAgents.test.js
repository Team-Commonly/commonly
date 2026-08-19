/**
 * Producer parity (ADR-024 D1): a board change must reach the pod's agents,
 * not just its Socket.io room.
 *
 * The bug these cover is not "the fan-out is wrong" — it is that every wrong
 * version of this fan-out is SILENT. A bespoke `task.*` type enqueues and acks
 * and does nothing; a missing claim key stampedes without error; a mispriced
 * `dmKind` loops until the cap catches it. None of those raise. So each test
 * here pins a property whose violation would otherwise look like calm.
 */
const mongoose = require('mongoose');

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn() },
}));

jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentEventService = require('../../../services/agentEventService');
const { notifyPodAgents } = require('../../../services/taskEventService');

const POD_ID = new mongoose.Types.ObjectId().toString();
const HUMAN_ID = new mongoose.Types.ObjectId().toString();
const AGENT_ID = new mongoose.Types.ObjectId().toString();

// Opted IN by default here, because every test below is about what an opted-in
// agent receives. The opt-OUT case gets its own test rather than being the
// silent default, so a gate regression fails loudly instead of emptying every
// assertion at once.
const install = (agentName, installedBy) => ({
  agentName,
  instanceId: 'default',
  podId: POD_ID,
  status: 'active',
  installedBy,
  config: { wakeOnMessage: { enabled: true } },
});

const task = (overrides = {}) => ({
  taskId: 'TASK-042',
  title: 'Wire the board to the fleet',
  status: 'todo',
  updatedAt: '2026-08-19T10:00:00.000Z',
  ...overrides,
});

const mockInstalls = (rows) => {
  AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) });
};

beforeEach(() => {
  jest.clearAllMocks();
  AgentEventService.enqueue.mockResolvedValue({});
});

describe('notifyPodAgents', () => {
  it('rides message.posted, because a bespoke task.* type reaches neither runtime', async () => {
    mockInstalls([install('scout', HUMAN_ID)]);

    await notifyPodAgents(POD_ID, task(), 'created', { userId: HUMAN_ID, isAgent: false });

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    const arg = AgentEventService.enqueue.mock.calls[0][0];
    // The wrapper's PROMPT_EVENT_TYPES is a closed set; anything outside it is
    // dropped after a successful ack, which is indistinguishable from silence.
    expect(arg.type).toBe('message.posted');
    // And the prompt has to be IN the payload — the wrapper reads
    // payload.content, not a structured task object.
    expect(arg.payload.content).toContain('TASK-042');
    expect(arg.payload.content).toContain('Wire the board to the fleet');
  });

  it('carries a synthetic claim key, so one agent takes the task and the rest stand down', async () => {
    mockInstalls([install('scout', HUMAN_ID), install('sprint-impl', HUMAN_ID)]);

    await notifyPodAgents(POD_ID, task(), 'created', { userId: HUMAN_ID, isAgent: false });

    const keys = AgentEventService.enqueue.mock.calls.map((c) => c[0].payload.messageId);
    expect(keys).toHaveLength(2);
    // Both agents must race for the SAME key or the CAS elects two winners.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('task:TASK-042:created:2026-08-19T10:00:00.000Z');
  });

  it('gives a later change to the same task a fresh key, or it collides with the settled claim', async () => {
    mockInstalls([install('scout', HUMAN_ID)]);

    await notifyPodAgents(POD_ID, task(), 'created', { userId: HUMAN_ID, isAgent: false });
    await notifyPodAgents(
      POD_ID,
      task({ updatedAt: '2026-08-19T11:00:00.000Z', status: 'in_progress' }),
      'updated',
      { userId: HUMAN_ID, isAgent: false },
    );

    const [first, second] = AgentEventService.enqueue.mock.calls.map((c) => c[0].payload.messageId);
    expect(first).not.toBe(second);
  });

  it('never wakes the actor about their own edit', async () => {
    mockInstalls([install('scout', AGENT_ID), install('sprint-impl', HUMAN_ID)]);

    await notifyPodAgents(POD_ID, task(), 'updated', { userId: AGENT_ID, isAgent: true });

    const woken = AgentEventService.enqueue.mock.calls.map((c) => c[0].agentName);
    expect(woken).toEqual(['sprint-impl']);
  });

  it('still wakes an agent when the HUMAN who installed it edits the board', async () => {
    // The self-skip nearly shipped keyed on `installedBy` alone. That field is
    // the agent's own user id when an agent self-installs, but the HUMAN's id
    // when a human installs it — so the skip silenced every agent for the one
    // person most likely to be moving tasks: its installer. It fails silently,
    // as an agent that simply never responds to its owner.
    mockInstalls([install('scout', HUMAN_ID)]);

    await notifyPodAgents(POD_ID, task(), 'created', { userId: HUMAN_ID, isAgent: false });

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue.mock.calls[0][0].agentName).toBe('scout');
  });

  it('prices a human edit as user-agent so it resets the cascade streak', async () => {
    mockInstalls([install('scout', AGENT_ID)]);

    await notifyPodAgents(POD_ID, task(), 'created', { userId: HUMAN_ID, isAgent: false });

    expect(AgentEventService.enqueue.mock.calls[0][0].payload.dmKind).toBe('user-agent');
  });

  it('prices an agent edit as agent-agent so board churn terminates at the cap', async () => {
    mockInstalls([install('scout', HUMAN_ID)]);

    await notifyPodAgents(POD_ID, task(), 'updated', { userId: AGENT_ID, isAgent: true });

    expect(AgentEventService.enqueue.mock.calls[0][0].payload.dmKind).toBe('agent-agent');
  });

  it('prices an UNKNOWN actor as an agent, because the two mistakes cost differently', async () => {
    mockInstalls([install('scout', HUMAN_ID)]);

    // Mislabelling a human costs one suppressed wake. Mislabelling an agent
    // costs an unbounded wake loop. A caller that forgets to pass an actor gets
    // the cheap failure.
    await notifyPodAgents(POD_ID, task(), 'updated');

    expect(AgentEventService.enqueue.mock.calls[0][0].payload.dmKind).toBe('agent-agent');
  });

  it('respects an opt-OUT, so ambient wakes cannot arrive through a second door', async () => {
    // 169 of 367 production installs have wake-on-message off — `commonly-bot`
    // and `openclaw`, user-facing seats where an unrequested wake is a noise
    // incident. A board change is ambient activity nobody addressed to them, so
    // it is governed by the same switch as ambient chat.
    mockInstalls([
      { ...install('commonly-bot', HUMAN_ID), config: { wakeOnMessage: { enabled: false } } },
      { ...install('openclaw', HUMAN_ID), config: {} },
      install('sprint-impl', HUMAN_ID),
    ]);

    await notifyPodAgents(POD_ID, task(), 'created', { userId: HUMAN_ID, isAgent: false });

    const woken = AgentEventService.enqueue.mock.calls.map((c) => c[0].agentName);
    expect(woken).toEqual(['sprint-impl']);
  });

  it('stays quiet on delete, where the wake would spend a turn finding nothing', async () => {
    mockInstalls([install('scout', HUMAN_ID)]);

    await notifyPodAgents(POD_ID, task(), 'deleted', { userId: HUMAN_ID, isAgent: false });

    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    // Cheap to assert, and it pins that we return before the query rather than
    // after it.
    expect(AgentInstallation.find).not.toHaveBeenCalled();
  });

  it('lets the other agents through when one enqueue throws', async () => {
    mockInstalls([install('scout', HUMAN_ID), install('sprint-impl', HUMAN_ID)]);
    AgentEventService.enqueue
      .mockRejectedValueOnce(new Error('event store unavailable'))
      .mockResolvedValueOnce({});

    await expect(
      notifyPodAgents(POD_ID, task(), 'created', { userId: HUMAN_ID, isAgent: false }),
    ).resolves.toBeUndefined();

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(2);
  });

  it('never lets a fan-out failure surface to the board write', async () => {
    AgentInstallation.find.mockImplementation(() => { throw new Error('mongo down'); });

    await expect(
      notifyPodAgents(POD_ID, task(), 'created', { userId: HUMAN_ID, isAgent: false }),
    ).resolves.toBeUndefined();
  });
});
