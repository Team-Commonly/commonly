jest.mock('../../../models/Installable', () => ({ find: jest.fn() }));
jest.mock('../../../models/InstallableInstallation', () => ({ find: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn() }));
jest.mock('../../../services/toolBrokerService', () => ({
  getToolDefinitions: () => [
    { name: 'github.list_issues', description: 'List issues', requiredWriteMode: 'read', connectionType: 'github-app' },
    { name: 'github.create_issue', description: 'Create an issue', requiredWriteMode: 'write-with-confirm', connectionType: 'github-app', irreversible: true },
  ],
}));
jest.mock('../../../services/roomGrantService', () => ({
  RoomGrantError: class RoomGrantError extends Error {},
}));
jest.mock('../../../integrations/manifests', () => ({
  manifests: {
    telegram: { id: 'telegram', readiness: jest.fn(() => ({ available: true })) },
    slack: { id: 'slack', readiness: jest.fn(() => ({ available: false, reason: 'not_configured' })) },
  },
}));

const Installable = require('../../../models/Installable');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const Integration = require('../../../models/Integration');
const { catalogFor } = require('../../../services/installable/installableCatalogService');

const userId = '64b64c48c4f37a6b2f34c111';
const installationId = '64b64c48c4f37a6b2f34c222';
const podId = '64b64c48c4f37a6b2f34c333';
const lean = (value) => ({ lean: jest.fn().mockResolvedValue(value) });
// The channel query is keyed by installableId; the tool query by component type.
const mockInstallables = (channels, tools = []) => Installable.find.mockImplementation((query) => (
  lean(query['components.type'] === 'mcp-server' ? tools : channels)
));
const githubTool = () => ({
  installableId: 'github',
  name: 'GitHub',
  description: 'Issues and pull requests.',
  components: [{ name: 'commonly-grant-broker', type: 'mcp-server', enabledTools: ['github.list_issues', 'github.create_issue'] }],
});

describe('installable catalog service', () => {
  beforeEach(() => jest.clearAllMocks());

  it('carries the flag beside the message, so the page can tell a reason from an exception', async () => {
    mockInstallables([
      { installableId: 'telegram', name: 'Telegram', description: 'Telegram description' },
      { installableId: 'slack', name: 'Slack', description: 'Slack description' },
    ]);
    InstallableInstallation.find.mockReturnValue(lean([
      {
        _id: installationId,
        installableId: 'telegram',
        status: 'error',
        errorMessage: "This connector's channel is gone. Retry to rebuild it.",
        // The reconciler's own constant: a writer declared it readable.
        errorMessageUserFacing: true,
        targetId: userId,
        installedBy: userId,
        components: [],
      },
      {
        _id: '6a8f6dc7a1dccf2e02f31099',
        installableId: 'slack',
        status: 'error',
        // `markProjectionFailure`'s raw exception: the same field, a different
        // kind of string, and the flag is what separates them.
        errorMessage: 'connect ECONNREFUSED 10.4.4.7:443',
        targetId: userId,
        installedBy: userId,
        components: [],
      },
    ]));
    Integration.find.mockReturnValue(lean([]));

    const catalog = await catalogFor(userId);
    const byId = Object.fromEntries(catalog.installables.map((entry) => [entry.installableId, entry.installation]));

    expect(byId.telegram.errorMessageUserFacing).toBe(true);
    expect(byId.slack.errorMessageUserFacing).toBe(false);
    // The message still travels — the page, not the mapper, decides what to show.
    expect(byId.slack.errorMessage).toBe('connect ECONNREFUSED 10.4.4.7:443');
  });

  it('returns provider readiness and the caller parent without leaking private fields', async () => {
    mockInstallables([
      { installableId: 'telegram', name: 'Telegram', description: 'Telegram description' },
      { installableId: 'slack', name: 'Slack', description: 'Slack description' },
    ]);
    InstallableInstallation.find.mockReturnValue(lean([{
      _id: installationId,
      installableId: 'telegram',
      status: 'error',
      errorMessage: "This connector's channel is gone. Retry to rebuild it.",
      targetId: 'another-user',
      installedBy: 'another-user',
      claimId: 'private-claim',
      boundPodId: podId,
      claimedAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:01:00.000Z',
      components: [{ componentName: 'telegram-webhook', status: 'stale' }],
    }]));
    Integration.find.mockReturnValue(lean([{
      installationId,
      type: 'telegram',
      config: {
        botTokenRef: 'secret-ref',
        oauthStateNonce: 'nonce',
        botToken: 'tg-bot-token',
        secretToken: 'tg-secret-token',
        accessToken: 'x-access-token',
        refreshToken: 'x-refresh-token',
        signingSecret: 'slack-signing-secret',
        webhookUrl: 'https://hooks.slack.com/services/T1/B1/hook-secret',
        connectCode: 'CODE-1',
        chatTitle: 'Ops',
        adminPause: {
          reason: 'Safety review in progress.',
          at: '2026-09-05T08:48:00.000Z',
          adminId: 'admin-private-id',
        },
      },
    }]));

    const catalog = await catalogFor(userId);

    expect(catalog.installables).toEqual([
      expect.objectContaining({
        installableId: 'telegram',
        list: 'channels',
        available: true,
        installation: {
          status: 'error',
          errorMessage: "This connector's channel is gone. Retry to rebuild it.",
          // The mapper hands over the provenance with the message, so the page
          // never has to guess from the shape of the string (TASK-131).
          errorMessageUserFacing: false,
          boundPodId: podId,
          claimedAt: '2026-09-05T00:00:00.000Z',
          updatedAt: '2026-09-05T00:01:00.000Z',
          components: [{ name: 'telegram-webhook', status: 'stale' }],
        },
        integration: expect.objectContaining({
          installationId,
          config: {
            connectCode: 'CODE-1',
            chatTitle: 'Ops',
            adminPause: {
              reason: 'Safety review in progress.',
              at: '2026-09-05T08:48:00.000Z',
            },
          },
        }),
      }),
      expect.objectContaining({
        installableId: 'slack',
        available: false,
        unavailableReason: 'not_configured',
        installation: null,
        integration: null,
      }),
    ]);
    expect(InstallableInstallation.find).toHaveBeenCalledWith(expect.objectContaining({ targetId: userId }));
    expect(JSON.stringify(catalog)).not.toMatch(/SLACK_|CONNECTOR_SECRET|private-claim|secret-ref|nonce|adminId|admin-private-id|-token|signing-secret|hook-secret/);
  });

  it('does not read projections when the caller has no live parent', async () => {
    mockInstallables([]);
    InstallableInstallation.find.mockReturnValue(lean([]));

    const catalog = await catalogFor(userId);

    expect(catalog.installables).toHaveLength(2);
    expect(Integration.find).not.toHaveBeenCalled();
  });

  it('the catalogue returns the GitHub tool Installable with its tools, broker and the caller\'s connections, on the tools list', async () => {
    process.env.GITHUB_APP_ID = 'app-1';
    process.env.GITHUB_APP_PRIVATE_KEY = 'pem';
    mockInstallables([], [githubTool()]);
    InstallableInstallation.find.mockReturnValue(lean([]));
    Integration.find.mockReturnValue(lean([{
      _id: 'conn-object-id',
      installationId: 'gh-install-1',
      type: 'github-app',
      status: 'connected',
      createdBy: userId,
      config: { owner: 'Team-Commonly', repo: 'commonly', privateKey: 'pem-material', installationToken: 'ghs_secret' },
    }]));

    const catalog = await catalogFor(userId);
    const tool = catalog.installables.find((entry) => entry.list === 'tools');

    expect(catalog.installables.filter((entry) => entry.list === 'channels')).toHaveLength(2);
    expect(tool).toEqual({
      installableId: 'github',
      list: 'tools',
      label: 'GitHub',
      description: 'Issues and pull requests.',
      available: true,
      broker: { id: 'commonly-grant-broker' },
      tools: [
        { name: 'github.list_issues', description: 'List issues', requiredWriteMode: 'read', irreversible: false },
        { name: 'github.create_issue', description: 'Create an issue', requiredWriteMode: 'write-with-confirm', irreversible: true },
      ],
      connections: [{ connectionId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' }],
      installation: null,
      integration: null,
    });
    expect(Integration.find).toHaveBeenCalledWith(expect.objectContaining({
      type: { $in: ['github-app'] }, createdBy: userId, status: 'connected', revokedAt: null,
    }));
    expect(JSON.stringify(catalog)).not.toMatch(/pem-material|ghs_secret|conn-object-id/);

    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    mockInstallables([], [githubTool()]);
    Integration.find.mockReturnValue(lean([]));
    const unconfigured = (await catalogFor(userId)).installables.find((entry) => entry.list === 'tools');
    expect(unconfigured).toMatchObject({ available: false, unavailableReason: 'not_configured', connections: [] });
  });
});
