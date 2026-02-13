jest.mock('../../../models/AgentEvent', () => ({
  create: jest.fn(),
  findOneAndUpdate: jest.fn(),
  find: jest.fn(),
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

  test('list normalizes numeric payload.messageId to string', async () => {
    AgentEvent.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'evt-1',
              agentName: 'openclaw',
              instanceId: 'liz',
              podId: 'pod-1',
              type: 'chat.mention',
              status: 'pending',
              payload: { messageId: 1800, content: 'hi' },
            },
          ]),
        }),
      }),
    });

    const events = await AgentEventService.list({
      agentName: 'openclaw',
      instanceId: 'liz',
      podId: 'pod-1',
      limit: 5,
    });

    expect(events).toHaveLength(1);
    expect(events[0].payload.messageId).toBe('1800');
  });
});
