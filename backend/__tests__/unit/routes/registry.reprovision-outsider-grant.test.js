jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(() => ({ runtime: 'moltbot' })),
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(true),
}));

const AgentIdentityService = require('../../../services/agentIdentityService');
const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');
const { reprovisionInstallation } = require('../../../routes/registry/reprovision');

describe('reprovision into a pod holding an outsider-writable grant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    podHasOutsiderWritableGrant.mockResolvedValue(true);
  });

  it('refuses a non-native runtime before identity, token, or runtime side effects', async () => {
    const installation = {
      podId: 'pod-1', agentName: 'openclaw', instanceId: 'default', save: jest.fn(),
    };
    await expect(reprovisionInstallation({ installation })).rejects.toMatchObject({
      code: 'outsider_grant_non_native_agent_join',
      message: expect.stringContaining('Use a separate pod'),
    });
    expect(AgentIdentityService.getOrCreateAgentUser).not.toHaveBeenCalled();
    expect(installation.save).not.toHaveBeenCalled();
  });
});
