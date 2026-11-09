// F361: an identity the kernel refuses to run (its owner lost cloudAgents) gets
// no new tokens on reprovision, and its account comes out of the gateway config
// so the gateway's own heartbeat stops calling the model.
const TYPE_RUNTIMES = {
  openclaw: 'moltbot', 'commonly-bot': 'internal', 'claude-code': 'claude-code', codex: 'codex',
};

jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'agent-user' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../services/outsiderGrantAgentJoinPolicy', () => ({
  assertAgentRuntimeMayJoinPod: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/hostedEngine', () => ({ hostedEngineInEffect: jest.fn(() => null) }));
jest.mock('../../../services/presetSkillsAutoImport', () => ({ applyPresetDefaultSkills: jest.fn() }));
jest.mock('../../../services/agentProvisionerService', () => ({
  ...jest.requireActual('../../../services/agentProvisionerService'),
  provisionAgentRuntime: jest.fn().mockResolvedValue({ accountId: 'a', restartRequired: false }),
  startAgentRuntime: jest.fn().mockResolvedValue({ started: true }),
  restartAgentRuntime: jest.fn().mockResolvedValue({ restarted: true }),
  removeOpenClawAccount: jest.fn().mockResolvedValue({ removed: ['scout'] }),
}));
jest.mock('../../../services/cloudRuntimeOwnership', () => ({ cloudRuntimeMayRun: jest.fn() }));
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
const {
  provisionAgentRuntime, removeOpenClawAccount, restartAgentRuntime,
} = require('../../../services/agentProvisionerService');
const { issueRuntimeTokenForAgent, revokeRuntimeTokensForAgent } = require('../../../routes/registry/tokens');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { cloudRuntimeMayRun } = require('../../../services/cloudRuntimeOwnership');
const { reprovisionInstallation } = require('../../../routes/registry/reprovision');

const install = (agentName, instanceId = 'scout') => ({
  _id: 'install-1', podId: 'pod-1', agentName, instanceId, config: {}, save: jest.fn(),
});

describe('reprovision of a refused identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentIdentityService.getAgentTypeConfig.mockImplementation((name) => (
      TYPE_RUNTIMES[name] ? { runtime: TYPE_RUNTIMES[name] } : null
    ));
    const query = { collation: () => query, select: () => query, lean: async () => [] };
    AgentInstallation.find.mockReturnValue(query);
  });

  it('removes the gateway account and issues nothing', async () => {
    cloudRuntimeMayRun.mockResolvedValue(false);
    const result = await reprovisionInstallation({ installation: install('openclaw') });
    expect(cloudRuntimeMayRun).toHaveBeenCalledWith('openclaw', 'scout');
    expect(removeOpenClawAccount).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'openclaw', instanceId: 'scout' }));
    expect(result).toEqual(expect.objectContaining({
      skipped: true, skipReason: 'cloud_agents_not_entitled', removedFromRuntime: true,
    }));
    expect(revokeRuntimeTokensForAgent).not.toHaveBeenCalled();
    expect(issueRuntimeTokenForAgent).not.toHaveBeenCalled();
    expect(provisionAgentRuntime).not.toHaveBeenCalled();
    // A single reprovision restarts the gateway itself; a bulk one leaves it to the end.
    expect(restartAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it('a gateway of its own is the one restarted, and a failed state edit is reported', async () => {
    cloudRuntimeMayRun.mockResolvedValue(false);
    const gateway = { _id: 'gw-1', slug: 'team', mode: 'k8s', status: 'active' };
    // eslint-disable-next-line global-require
    const Gateway = require('../../../models/Gateway');
    const spy = jest.spyOn(Gateway, 'findById').mockReturnValue({ lean: async () => gateway });
    removeOpenClawAccount.mockResolvedValueOnce({ removed: ['scout'], stateError: 'The state file edit failed.' });
    const installation = { ...install('openclaw'), config: { runtime: { gatewayId: 'gw-1' } } };

    const result = await reprovisionInstallation({ installation });

    expect(removeOpenClawAccount).toHaveBeenCalledWith(expect.objectContaining({ gateway }));
    expect(restartAgentRuntime).toHaveBeenCalledWith('moltbot', 'scout', { gateway });
    expect(result).toEqual(expect.objectContaining({
      removedFromRuntime: true, runtimeGatewayId: 'gw-1', runtimeRemovalError: 'The state file edit failed.',
    }));
    spy.mockRestore();
  });

  it('a single run reports a restart that failed, which restartAgentRuntime returns rather than throws', async () => {
    cloudRuntimeMayRun.mockResolvedValue(false);
    restartAgentRuntime.mockResolvedValueOnce({ restarted: false, reason: 'forbidden' });
    const result = await reprovisionInstallation({ installation: install('openclaw') });
    expect(result).toEqual(expect.objectContaining({
      removedFromRuntime: true, runtimeRestartNeeded: true,
    }));
    expect(result.runtimeRemovalError).toMatch(/gateway restart failed \(forbidden\)/);
  });

  it('a removal that found no Deployment restarts nothing and owes no restart', async () => {
    cloudRuntimeMayRun.mockResolvedValue(false);
    removeOpenClawAccount.mockResolvedValueOnce({ removed: ['scout'], deploymentMissing: true });
    const result = await reprovisionInstallation({ installation: install('openclaw') });
    expect(restartAgentRuntime).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ removedFromRuntime: true, runtimeRestartNeeded: false }));
    expect(result.runtimeRemovalError).toBeUndefined();
  });

  it('a bulk run leaves the restart to the end', async () => {
    cloudRuntimeMayRun.mockResolvedValue(false);
    await reprovisionInstallation({ installation: install('openclaw'), skipRuntimeRestart: true });
    expect(restartAgentRuntime).not.toHaveBeenCalled();
  });

  it('an entitled identity provisions as before', async () => {
    cloudRuntimeMayRun.mockResolvedValue(true);
    await reprovisionInstallation({ installation: install('openclaw') });
    expect(removeOpenClawAccount).not.toHaveBeenCalled();
    expect(provisionAgentRuntime).toHaveBeenCalled();
  });

  it('only the gateway runtime is read', async () => {
    cloudRuntimeMayRun.mockResolvedValue(false);
    await reprovisionInstallation({ installation: install('commonly-bot', 'default') });
    expect(cloudRuntimeMayRun).not.toHaveBeenCalled();
    expect(removeOpenClawAccount).not.toHaveBeenCalled();
  });
});
