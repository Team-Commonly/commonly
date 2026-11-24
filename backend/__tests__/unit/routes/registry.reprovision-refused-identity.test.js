// A stored OpenClaw (moltbot) identity gets no new tokens on reprovision: the
// runtime is retired (ADR-021), so it is skipped as runtime_retired whether or
// not its owner is still entitled to cloud agents, and a bulk run carries on.
const TYPE_RUNTIMES = {
  openclaw: 'moltbot', 'commonly-bot': 'internal', 'claude-code': 'claude-code', codex: 'codex',
};

jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(),
  identityNames: jest.fn((name) => [name]),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'agent-user' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../services/outsiderGrantAgentJoinPolicy', () => ({
  assertAgentRuntimeMayJoinPod: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/hostedEngine', () => ({ hostedEngineInEffect: jest.fn(() => null) }));
jest.mock('../../../services/agentProvisionerService', () => ({
  ...jest.requireActual('../../../services/agentProvisionerService'),
  provisionAgentRuntime: jest.fn().mockResolvedValue({ accountId: 'a', restartRequired: false }),
  startAgentRuntime: jest.fn().mockResolvedValue({ started: true }),
  restartAgentRuntime: jest.fn().mockResolvedValue({ restarted: true }),
}));
jest.mock('../../../routes/registry/tokens', () => ({
  revokeRuntimeTokensForAgent: jest.fn().mockResolvedValue([]),
  issueRuntimeTokenForAgent: jest.fn().mockResolvedValue({ token: 'new-token' }),
  issueUserTokenForInstallation: jest.fn().mockResolvedValue({ token: 'new-user-token' }),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn() },
}));
jest.mock('../../../models/Integration', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
}));
jest.mock('../../../models/AgentProfile', () => ({ updateMany: jest.fn(), findOne: jest.fn(() => ({ lean: async () => null })) }));

const AgentIdentityService = require('../../../services/agentIdentityService');
const { provisionAgentRuntime, restartAgentRuntime } = require('../../../services/agentProvisionerService');
const { issueRuntimeTokenForAgent, revokeRuntimeTokensForAgent } = require('../../../routes/registry/tokens');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { reprovisionInstallation } = require('../../../routes/registry/reprovision');

const install = (agentName, instanceId = 'scout') => ({
  _id: 'install-1', podId: 'pod-1', agentName, instanceId, config: {}, save: jest.fn(),
});

describe('reprovision of a stored OpenClaw identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentIdentityService.getAgentTypeConfig.mockImplementation((name) => (
      TYPE_RUNTIMES[name] ? { runtime: TYPE_RUNTIMES[name] } : null
    ));
    const query = { collation: () => query, select: () => query, lean: async () => [] };
    AgentInstallation.find.mockReturnValue(query);
  });

  it.each([false, true])('a moltbot identity (forced: %s) is skipped as retired, with no token, provision or restart', async (force) => {
    const result = await reprovisionInstallation({ installation: install('openclaw'), force });
    expect(result).toMatchObject({ skipped: true, skipReason: 'runtime_retired', runtimeType: 'moltbot' });
    expect(issueRuntimeTokenForAgent).not.toHaveBeenCalled();
    expect(revokeRuntimeTokensForAgent).not.toHaveBeenCalled();
    expect(provisionAgentRuntime).not.toHaveBeenCalled();
    expect(restartAgentRuntime).not.toHaveBeenCalled();
    expect(AgentIdentityService.getOrCreateAgentUser).not.toHaveBeenCalled();
  });

  it('every other runtime still reaches the provisioner', async () => {
    const result = await reprovisionInstallation({ installation: install('commonly-bot', 'default') });
    expect(result.skipReason).toBeUndefined();
    expect(provisionAgentRuntime).toHaveBeenCalledWith(expect.objectContaining({ runtimeType: 'internal' }));
  });
});
