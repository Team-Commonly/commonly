jest.mock('../../../models/AgentEvent', () => ({
  create: jest.fn(),
  findOneAndUpdate: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../../../models/AgentMemory', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn(),
}));

jest.mock('../../../services/agentMemoryService', () => ({
  buildMemoryDigestBundle: jest.fn(() => ({})),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
}));

jest.mock('../../../models/Integration', () => ({}));

jest.mock('../../../models/Gateway', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(),
}));

jest.mock('../../../services/agentProvisionerService', () => ({
  clearAgentRuntimeSessions: jest.fn(),
  restartAgentRuntime: jest.fn(),
  resolveOpenClawAccountId: jest.fn(({ agentName, instanceId }) => `${agentName}-${instanceId}`),
}));

const AgentEvent = require('../../../models/AgentEvent');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const Gateway = require('../../../models/Gateway');
const AgentIdentityService = require('../../../services/agentIdentityService');
const {
  clearAgentRuntimeSessions,
  restartAgentRuntime,
} = require('../../../services/agentProvisionerService');
const AgentEventService = require('../../../services/agentEventService');

describe('AgentEventService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AGENT_CONTEXT_OVERFLOW_RETRY_LIMIT;
  });

  test('acknowledge auto-recovers OpenClaw context overflow and re-enqueues once', async () => {
    AgentIdentityService.getAgentTypeConfig.mockReturnValue({ runtime: 'moltbot' });
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-1',
      agentName: 'tarik',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'heartbeat',
      payload: { trigger: 'scheduled-interval' },
      status: 'delivered',
      attempts: 1,
      delivery: { outcome: 'error', reason: 'Context overflow: prompt too large for model' },
    });
    AgentInstallation.findOne.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue({ config: { runtime: { gatewayId: 'gw-1' } } }),
      }),
    });
    Gateway.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'gw-1', mode: 'k8s', status: 'active' }),
    });
    clearAgentRuntimeSessions.mockResolvedValue({ cleared: true });
    restartAgentRuntime.mockResolvedValue({ restarted: true });
    AgentEvent.create.mockResolvedValue({
      _id: 'evt-retry-1',
      agentName: 'tarik',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'heartbeat',
      payload: { trigger: 'scheduled-interval:context-overflow-retry' },
      status: 'pending',
      attempts: 0,
    });

    await AgentEventService.acknowledge(
      'evt-1',
      'tarik',
      'default',
      { outcome: 'error', reason: 'Context overflow: prompt too large for model' },
    );

    expect(clearAgentRuntimeSessions).toHaveBeenCalledTimes(1);
    expect(restartAgentRuntime).toHaveBeenCalledTimes(1);
    expect(AgentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'tarik',
        instanceId: 'default',
        type: 'heartbeat',
        payload: expect.objectContaining({
          _contextOverflowRetryCount: 1,
        }),
      }),
    );
  });

  test('acknowledge does not retry after retry limit reached', async () => {
    AgentIdentityService.getAgentTypeConfig.mockReturnValue({ runtime: 'moltbot' });
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-2',
      agentName: 'tarik',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'heartbeat',
      payload: {
        trigger: 'scheduled-interval',
        _contextOverflowRetryCount: 1,
      },
      status: 'delivered',
      attempts: 2,
      delivery: { outcome: 'error', reason: 'prompt too large' },
    });

    await AgentEventService.acknowledge(
      'evt-2',
      'tarik',
      'default',
      { outcome: 'error', reason: 'prompt too large' },
    );

    expect(clearAgentRuntimeSessions).not.toHaveBeenCalled();
    expect(restartAgentRuntime).not.toHaveBeenCalled();
    expect(AgentEvent.create).not.toHaveBeenCalled();
  });

  test('clearOpenClawSessionsForActiveInstallations deduplicates by instance and gateway', async () => {
    AgentInstallation.find.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue([
          {
            agentName: 'tarik',
            instanceId: 'default',
            podId: 'pod-1',
            config: { runtime: { gatewayId: 'gw-1' } },
          },
          {
            agentName: 'tarik',
            instanceId: 'default',
            podId: 'pod-2',
            config: { runtime: { gatewayId: 'gw-1' } },
          },
          {
            agentName: 'commonly-bot',
            instanceId: 'default',
            podId: 'pod-3',
            config: {},
          },
        ]),
      }),
    });
    AgentIdentityService.getAgentTypeConfig.mockImplementation((agentName) => (
      agentName === 'tarik' ? { runtime: 'moltbot' } : { runtime: 'internal' }
    ));
    Gateway.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'gw-1', mode: 'k8s', status: 'active' }),
    });
    clearAgentRuntimeSessions.mockResolvedValue({ cleared: true });
    restartAgentRuntime.mockResolvedValue({ restarted: true });

    const result = await AgentEventService.clearOpenClawSessionsForActiveInstallations({
      source: 'scheduled-session-reset',
      restart: true,
    });

    expect(result.scannedInstallations).toBe(3);
    expect(result.targetedInstances).toBe(1);
    expect(result.clearedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(clearAgentRuntimeSessions).toHaveBeenCalledTimes(1);
    expect(restartAgentRuntime).toHaveBeenCalledTimes(1);
  });

  test('list mutates pending → delivered, captures memoryRevisionAtDelivery, injects digest bundle, normalizes messageId', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    const { buildMemoryDigestBundle } = require('../../../services/agentMemoryService');

    AgentEvent.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: jest.fn().mockResolvedValue([{ _id: 'evt-1' }]),
          }),
        }),
      }),
    });

    AgentMemory.findOne.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue({
          revision: 7,
          lastSeenRevision: 5,
          sections: { /* shape-only */ },
        }),
      }),
    });

    buildMemoryDigestBundle.mockReturnValue({
      memoryRevision: 7,
      memoryDigest: [{ takeaway: 'a' }, { takeaway: 'b' }],
      cyclesDigest: [{ ts: new Date(), content: 'c' }],
      longTermDigest: 'durable',
    });

    AgentEvent.findOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'evt-1',
        agentName: 'openclaw',
        instanceId: 'liz',
        podId: 'pod-1',
        type: 'chat.mention',
        status: 'delivered',
        memoryRevisionAtDelivery: 7,
        payload: { messageId: 1800, content: 'hi' },
      }),
    });

    const events = await AgentEventService.list({
      agentName: 'openclaw',
      instanceId: 'liz',
      podId: 'pod-1',
      limit: 5,
    });

    // ADR-012 §3: claim mutates with the right shape — gated on status pending,
    // sets status: 'delivered' + memoryRevisionAtDelivery atomically.
    expect(AgentEvent.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'evt-1', status: 'pending' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'delivered',
          memoryRevisionAtDelivery: 7,
        }),
      }),
      { new: true },
    );

    expect(buildMemoryDigestBundle).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 7, lastSeenRevision: 5 }),
      5,
    );

    expect(events).toHaveLength(1);
    // ADR-012 §10.2: payload spreads digest bundle alongside existing fields.
    expect(events[0].payload).toEqual(expect.objectContaining({
      content: 'hi',
      messageId: '1800',
      memoryRevision: 7,
      memoryDigest: [{ takeaway: 'a' }, { takeaway: 'b' }],
      cyclesDigest: expect.any(Array),
      longTermDigest: 'durable',
    }));
  });

  test('list returns [] when no candidates are pending (no envelope read)', async () => {
    const AgentMemory = require('../../../models/AgentMemory');

    AgentEvent.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });

    const events = await AgentEventService.list({
      agentName: 'openclaw',
      instanceId: 'liz',
      podId: 'pod-1',
      limit: 5,
    });

    expect(events).toEqual([]);
    // No memory read should fire when there's nothing to claim.
    expect(AgentMemory.findOne).not.toHaveBeenCalled();
  });

  test('list: lost-race candidate produces null update; result is filtered out', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    const { buildMemoryDigestBundle } = require('../../../services/agentMemoryService');

    AgentEvent.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: jest.fn().mockResolvedValue([{ _id: 'won' }, { _id: 'lost' }]),
          }),
        }),
      }),
    });

    AgentMemory.findOne.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue({ revision: 1, lastSeenRevision: 0, sections: {} }),
      }),
    });
    buildMemoryDigestBundle.mockReturnValue({});

    AgentEvent.findOneAndUpdate
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue({
          _id: 'won', agentName: 'a', instanceId: 'i', podId: 'p', type: 't', payload: {},
          status: 'delivered', memoryRevisionAtDelivery: 1,
        }),
      })
      .mockReturnValueOnce({
        // The losing candidate: another poller already flipped it; status-gate
        // returns null.
        lean: jest.fn().mockResolvedValue(null),
      });

    const events = await AgentEventService.list({
      agentName: 'a', instanceId: 'i', podId: 'p', limit: 5,
    });

    expect(events.map((e) => e._id)).toEqual(['won']);
  });

  test('acknowledge: status-gated delivered → acked + bumps lastSeenRevision via $max', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    AgentIdentityService.getAgentTypeConfig.mockReturnValue({ runtime: 'moltbot' });
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-1',
      agentName: 'pixel',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'heartbeat',
      payload: {},
      status: 'acked',
      attempts: 1,
      memoryRevisionAtDelivery: 7,
    });

    await AgentEventService.acknowledge('evt-1', 'pixel', 'default', { outcome: 'no_action', reason: 'nothing-to-do' });

    expect(AgentEvent.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'evt-1',
        agentName: 'pixel',
        instanceId: 'default',
        status: { $in: ['pending', 'delivered'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'acked' }),
      }),
      { new: true },
    );

    expect(AgentMemory.updateOne).toHaveBeenCalledWith(
      { agentName: 'pixel', instanceId: 'default' },
      { $max: { lastSeenRevision: 7 } },
    );
  });

  test('acknowledge: dup ack returns null without bumping lastSeenRevision', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    AgentIdentityService.getAgentTypeConfig.mockReturnValue({ runtime: 'moltbot' });
    // findOneAndUpdate returns null because status was already 'acked'.
    AgentEvent.findOneAndUpdate.mockResolvedValue(null);

    const result = await AgentEventService.acknowledge('evt-1', 'pixel', 'default', { outcome: 'no_action' });

    expect(result).toBeNull();
    expect(AgentMemory.updateOne).not.toHaveBeenCalled();
  });

  test('acknowledge: skips bump when memoryRevisionAtDelivery is null/0', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    AgentIdentityService.getAgentTypeConfig.mockReturnValue({ runtime: 'moltbot' });
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-2',
      agentName: 'pixel',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'heartbeat',
      payload: {},
      status: 'acked',
      attempts: 1,
      memoryRevisionAtDelivery: null,
    });

    await AgentEventService.acknowledge('evt-2', 'pixel', 'default', { outcome: 'no_action' });

    expect(AgentMemory.updateOne).not.toHaveBeenCalled();
  });
});
