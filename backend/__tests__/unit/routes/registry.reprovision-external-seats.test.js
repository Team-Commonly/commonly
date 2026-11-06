// A token issued here reaches a seat only through the provisioner. A seat that
// runs anywhere else keeps the token it already has and can't learn a new one.
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
const { provisionAgentRuntime } = require('../../../services/agentProvisionerService');
const {
  revokeRuntimeTokensForAgent, issueRuntimeTokenForAgent, issueUserTokenForInstallation,
} = require('../../../routes/registry/tokens');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { reprovisionInstallation } = require('../../../routes/registry/reprovision');

const install = (agentName, runtime) => ({
  _id: 'install-1',
  podId: 'pod-1',
  agentName,
  instanceId: 'default',
  config: runtime ? { runtime } : {},
  save: jest.fn(),
});

const siblings = (...rows) => {
  const query = { collation: () => query, select: () => query, lean: async () => rows };
  AgentInstallation.find.mockReturnValue(query);
};

describe('reprovision and tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentIdentityService.getAgentTypeConfig.mockImplementation((name) => (
      TYPE_RUNTIMES[name] ? { runtime: TYPE_RUNTIMES[name] } : null
    ));
    siblings();
  });

  const untouched = (installation) => {
    expect(revokeRuntimeTokensForAgent).not.toHaveBeenCalled();
    expect(issueRuntimeTokenForAgent).not.toHaveBeenCalled();
    expect(issueUserTokenForInstallation).not.toHaveBeenCalled();
    expect(provisionAgentRuntime).not.toHaveBeenCalled();
    expect(installation.save).not.toHaveBeenCalled();
  };

  it.each([
    ['a webhook seat', 'gridrunner', { runtimeType: 'webhook', host: 'byo' }],
    ['a webhook seat with no host', 'wisp', { runtimeType: 'webhook' }],
    ['a Claude Code wrapper', 'asso-app', { runtimeType: 'claude-code', host: 'byo' }],
    ['a wrapper on the bare claude-code name', 'claude-code', { runtimeType: 'claude-code', host: 'byo' }],
    ['a cloud-labelled claude-code row', 'claude-code', { runtimeType: 'claude-code', host: 'cloud' }],
    ['a Codex wrapper', 'anvil', { runtimeType: 'codex', host: 'byo' }],
    ['a wrapper on the bare codex name', 'codex', { runtimeType: 'codex', host: 'byo' }],
    ['a codex row with no host', 'codex', { runtimeType: 'codex' }],
    ['a dsh wrapper', 'zz-dsh', { runtimeType: 'dsh', host: 'byo' }],
    ['a BYO seat with no runtime type', 'folio', { host: 'byo' }],
    ['a BYO seat on a name the gateway owns', 'openclaw', { host: 'byo' }],
    ['a BYO seat on an internal name', 'commonly-bot', { runtimeType: 'webhook', host: 'byo' }],
    ['a native agent', 'scout', { runtimeType: 'native' }],
    ['a hosted agent', 'commonly-triage', { runtimeType: 'hosted' }],
    ['a row with no runtime on an unknown name', 'swift', null],
    ['a bare codex row with no runtime', 'codex', null],
  ])('%s keeps its token and its install record', async (_label, agentName, runtime) => {
    const installation = install(agentName, runtime);
    const result = await reprovisionInstallation({ installation, force: true });
    expect(result).toMatchObject({ skipped: true, skipReason: 'keeps_its_own_token' });
    untouched(installation);
  });

  it.each([
    ['moltbot', 'openclaw', { runtimeType: 'moltbot' }],
    ['internal', 'commonly-bot', { runtimeType: 'internal', host: 'cloud' }],
    ['internal with no runtime record', 'commonly-bot', null],
  ])('%s still rotates, because the provisioner hands the new token over', async (_label, agentName, runtime) => {
    const installation = install(agentName, runtime);
    const result = await reprovisionInstallation({ installation, force: true });
    expect(result.skipped).toBeUndefined();
    expect(revokeRuntimeTokensForAgent).toHaveBeenCalledTimes(1);
    expect(provisionAgentRuntime).toHaveBeenCalledWith(expect.objectContaining({ runtimeToken: 'new-token' }));
    expect(installation.save).toHaveBeenCalled();
  });

  it('a gateway row keeps its token when a wrapper shares its identity, since a revoke reaches every copy', async () => {
    siblings({ config: { runtime: { runtimeType: 'moltbot' } } }, { config: { runtime: { host: 'byo' } } });
    const installation = install('openclaw', { runtimeType: 'moltbot' });
    const result = await reprovisionInstallation({ installation, force: true });
    expect(result).toMatchObject({ skipped: true, skipReason: 'shares_identity_with_external_seat' });
    untouched(installation);
  });
});
