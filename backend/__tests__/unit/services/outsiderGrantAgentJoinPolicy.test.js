jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn(),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn() },
}));

const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const {
  assertAgentRuntimeMayJoinPod,
  assertInstalledAgentMayJoinPod,
  runtimeTypeFromConfig,
} = require('../../../services/outsiderGrantAgentJoinPolicy');

describe('outsider-writable grant agent join policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    podHasOutsiderWritableGrant.mockResolvedValue(true);
  });

  it('refuses a non-native join with a separate-pod reason', async () => {
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'opencode')).rejects.toMatchObject({
      code: 'outsider_grant_non_native_agent_join',
      statusCode: 403,
      message: expect.stringContaining('Use a separate pod'),
    });
  });

  it('allows a native agent and a non-native agent after the grant ends', async () => {
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'native')).resolves.toBeUndefined();
    expect(podHasOutsiderWritableGrant).not.toHaveBeenCalled();
    podHasOutsiderWritableGrant.mockResolvedValue(false);
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'opencode')).resolves.toBeUndefined();
  });

  it('requires a live native installation for an undeclared membership writer', async () => {
    AgentInstallation.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({
        config: new Map([['runtime', { runtimeType: 'native' }]]),
      }) }),
    });
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'sample-agent', 'default')).resolves.toBeUndefined();
    expect(AgentInstallation.findOne).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'pod-1', agentName: 'sample-agent', instanceId: 'default', status: 'active',
    }));
    expect(runtimeTypeFromConfig(new Map([['runtime', { runtimeType: 'native' }]]))).toBe('native');
  });

  it('refuses absent and non-native installations before membership', async () => {
    const lean = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      config: new Map([['runtime', { runtimeType: 'webhook' }]]),
    });
    AgentInstallation.findOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean }) });
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'bot', 'default')).rejects.toHaveProperty(
      'code', 'outsider_grant_non_native_agent_join',
    );
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'bot', 'default')).rejects.toHaveProperty(
      'code', 'outsider_grant_non_native_agent_join',
    );
  });
});
