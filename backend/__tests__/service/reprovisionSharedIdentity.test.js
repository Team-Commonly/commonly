// A revoke reaches every install of an identity, whatever its status and however
// its instance id is cased, so the same-identity check has to read the same rows.
// This is a real mongod because the claim is about which rows a query matches; a
// mocked model only reports the filter it was handed.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(() => ({ runtime: 'moltbot' })),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'agent-user' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/outsiderGrantAgentJoinPolicy', () => ({
  assertAgentRuntimeMayJoinPod: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/hostedEngine', () => ({ hostedEngineInEffect: jest.fn(() => null) }));
jest.mock('../../services/presetSkillsAutoImport', () => ({ applyPresetDefaultSkills: jest.fn() }));
jest.mock('../../services/agentProvisionerService', () => ({
  ...jest.requireActual('../../services/agentProvisionerService'),
  provisionAgentRuntime: jest.fn().mockResolvedValue({ accountId: 'a', restartRequired: false }),
  startAgentRuntime: jest.fn().mockResolvedValue({ started: true }),
  restartAgentRuntime: jest.fn().mockResolvedValue({ restarted: true }),
}));
jest.mock('../../routes/registry/tokens', () => ({
  revokeRuntimeTokensForAgent: jest.fn().mockResolvedValue([]),
  issueRuntimeTokenForAgent: jest.fn().mockResolvedValue({ token: 'new-token' }),
  issueUserTokenForInstallation: jest.fn().mockResolvedValue({ token: 'new-user-token' }),
}));

const { AgentInstallation } = require('../../models/AgentRegistry');
const { revokeRuntimeTokensForAgent } = require('../../routes/registry/tokens');
const { reprovisionInstallation } = require('../../routes/registry/reprovision');

const seed = (instanceId, runtime, status = 'active') => AgentInstallation.create({
  agentName: 'openclaw',
  instanceId,
  podId: new mongoose.Types.ObjectId(),
  installedBy: new mongoose.Types.ObjectId(),
  displayName: 'OpenClaw',
  version: '1.0.0',
  status,
  config: { runtime },
});

describe('reprovision and the rows a revoke reaches', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
  });

  it.each([
    ['in a different case', 'CTO', 'active'],
    ['that is paused', 'cto', 'paused'],
  ])('a gateway row spares a wrapper %s', async (_label, siblingInstanceId, status) => {
    const installation = await seed('cto', { runtimeType: 'moltbot' });
    await seed(siblingInstanceId, { runtimeType: 'claude-code', host: 'byo' }, status);
    const result = await reprovisionInstallation({ installation, force: true });
    expect(result).toMatchObject({ skipped: true, skipReason: 'shares_identity_with_external_seat' });
    expect(revokeRuntimeTokensForAgent).not.toHaveBeenCalled();
  });

  it('a gateway row with no outside sibling still rotates', async () => {
    const installation = await seed('cto', { runtimeType: 'moltbot' });
    await seed('other', { runtimeType: 'claude-code', host: 'byo' });
    const result = await reprovisionInstallation({ installation, force: true });
    expect(result.skipped).toBeUndefined();
    expect(revokeRuntimeTokensForAgent).toHaveBeenCalledTimes(1);
  });
});
