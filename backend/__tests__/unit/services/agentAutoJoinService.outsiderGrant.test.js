jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/Activity', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: {
  find: jest.fn(), isInstalled: jest.fn(), install: jest.fn(),
} }));
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1', username: 'bot' }),
  ensureAgentInPod: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(true),
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');
const AgentAutoJoinService = require('../../../services/agentAutoJoinService');

const chain = (rows) => ({ select: () => ({ lean: async () => rows }) });

describe('auto-join into a pod holding an outsider-writable grant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    podHasOutsiderWritableGrant.mockResolvedValue(true);
    Pod.find.mockReturnValue(chain([{ _id: 'target-pod' }]));
    AgentInstallation.isInstalled.mockResolvedValue(false);
    AgentInstallation.install.mockResolvedValue({});
  });

  it('skips a non-native source before installing or adding membership', async () => {
    AgentInstallation.find.mockReturnValue(chain([{
      agentName: 'seat', instanceId: 'default', podId: 'source-pod',
      config: new Map([['runtime', { runtimeType: 'opencode' }]]),
    }]));
    const result = await AgentAutoJoinService.runAutoJoinAgentOwnedPods();
    expect(result).toEqual(expect.objectContaining({ installed: 0, skipped: 1 }));
    expect(AgentInstallation.install).not.toHaveBeenCalled();
  });

  it('copies a native Map declaration into the new installation', async () => {
    AgentInstallation.find.mockReturnValue(chain([{
      agentName: 'native-agent', instanceId: 'default', podId: 'source-pod',
      config: new Map([['runtime', { runtimeType: 'native' }]]),
    }]));
    const result = await AgentAutoJoinService.runAutoJoinAgentOwnedPods();
    expect(result).toEqual(expect.objectContaining({ installed: 1, skipped: 0 }));
    expect(AgentInstallation.install).toHaveBeenCalledWith(
      'native-agent', 'target-pod', expect.objectContaining({
        config: expect.objectContaining({ runtime: { runtimeType: 'native' } }),
      }),
    );
  });
});
