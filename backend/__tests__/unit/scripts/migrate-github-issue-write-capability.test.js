jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    updateMany: jest.fn(),
  },
}));
jest.mock('../../../services/githubIssueWriteCapability', () => ({
  isConfiguredDevTierGitHubIssueWriter: jest.fn(),
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const { isConfiguredDevTierGitHubIssueWriter } = require('../../../services/githubIssueWriteCapability');
const {
  migrateGitHubIssueWriteCapability,
} = require('../../../scripts/migrate-github-issue-write-capability');

const findResult = (installations) => ({
  select: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue(installations),
  }),
});

describe('migrateGitHubIssueWriteCapability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentInstallation.updateMany.mockResolvedValue({ modifiedCount: 0 });
  });

  test('grants every legacy install for a configured dev identity once, while leaving other identities ungranted', async () => {
    AgentInstallation.find.mockReturnValue(findResult([
      { agentName: 'openclaw', instanceId: 'theo' },
      { agentName: 'openclaw', instanceId: 'theo' },
      { agentName: 'codex', instanceId: 'theo' },
    ]));
    isConfiguredDevTierGitHubIssueWriter
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    AgentInstallation.updateMany.mockResolvedValue({ modifiedCount: 2 });

    const result = await migrateGitHubIssueWriteCapability();

    expect(AgentInstallation.find).toHaveBeenCalledWith({
      status: 'active',
      githubIssueWrite: { $exists: false },
    });
    expect(isConfiguredDevTierGitHubIssueWriter).toHaveBeenNthCalledWith(1, {
      agentName: 'openclaw', instanceId: 'theo', installationCount: 2,
    });
    expect(isConfiguredDevTierGitHubIssueWriter).toHaveBeenNthCalledWith(2, {
      agentName: 'codex', instanceId: 'theo', installationCount: 1,
    });
    expect(AgentInstallation.updateMany).toHaveBeenCalledTimes(1);
    expect(AgentInstallation.updateMany).toHaveBeenCalledWith(
      {
        agentName: 'openclaw',
        instanceId: 'theo',
        status: 'active',
        githubIssueWrite: { $exists: false },
      },
      { $set: { githubIssueWrite: true } },
    );
    expect(result).toMatchObject({
      legacyInstallations: 3,
      identitiesChecked: 2,
      identitiesGranted: 1,
      installationsGranted: 2,
      dryRun: false,
    });
  });

  test('dry run reports the exact legacy grant plan without writing', async () => {
    AgentInstallation.find.mockReturnValue(findResult([
      { agentName: 'openclaw', instanceId: 'theo' },
      { agentName: 'openclaw', instanceId: 'theo' },
    ]));
    isConfiguredDevTierGitHubIssueWriter.mockResolvedValue(true);

    const result = await migrateGitHubIssueWriteCapability({ dryRun: true });

    expect(AgentInstallation.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      identitiesGranted: 1,
      installationsGranted: 2,
      dryRun: true,
    });
  });

  test('never re-grants explicit false rows: only the legacy absent-field query is eligible', async () => {
    AgentInstallation.find.mockReturnValue(findResult([]));

    await migrateGitHubIssueWriteCapability();

    expect(AgentInstallation.find).toHaveBeenCalledWith({
      status: 'active',
      githubIssueWrite: { $exists: false },
    });
    expect(isConfiguredDevTierGitHubIssueWriter).not.toHaveBeenCalled();
    expect(AgentInstallation.updateMany).not.toHaveBeenCalled();
  });

  test('normalizes a missing instanceId to the canonical default identity', async () => {
    AgentInstallation.find.mockReturnValue(findResult([
      { agentName: 'openclaw' },
    ]));
    isConfiguredDevTierGitHubIssueWriter.mockResolvedValue(true);
    AgentInstallation.updateMany.mockResolvedValue({ modifiedCount: 1 });

    await migrateGitHubIssueWriteCapability();

    expect(AgentInstallation.updateMany).toHaveBeenCalledWith(
      {
        agentName: 'openclaw',
        instanceId: { $in: ['default', null] },
        status: 'active',
        githubIssueWrite: { $exists: false },
      },
      { $set: { githubIssueWrite: true } },
    );
  });
});
