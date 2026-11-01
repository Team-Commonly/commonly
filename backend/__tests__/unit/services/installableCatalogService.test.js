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
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const { buildHostedMcpToolInstallable } = require('../../../services/installable/toolInstallables');
const { hiddenHostedMcpEntryIds } = require('../../../integrations/hostedMcp/visibility');

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
      // The connect descriptor is per row, and a github-app row has no entry to
      // name: its connections are not per entry, so it carries the type and no
      // `entryId`. The hosted half is asserted below.
      connectionType: 'github-app',
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

/**
 * Scope §7, catalogue half: a hosted entry is offered as a tools row, and its
 * Connections are its OWN.
 *
 * One `connectionType` covers every vendor this type serves, so the connection
 * filter has to read `config.entryId` too — without that half, a person's Linear
 * row is offered as a grantable connection under every other hosted entry, and
 * the mint would then refuse the grant it just offered (one entry's tools cannot
 * name another's). The fixture adds a second vendor beside the shipped one
 * because a filter cannot be witnessed with a single value.
 */
it("a hosted entry's tool row carries its connect descriptor and only its own connections", async () => {
  const acme = {
    id: 'acme',
    title: 'Acme',
    description: 'Tickets in Acme.',
    connectNotice: 'Ask your admin to allow this connection first.',
    accessPage: 'https://acme.example/install',
    resource: 'https://mcp.acme.example/mcp',
    issuer: 'https://mcp.acme.example',
    client: 'cimd',
    scopes: ['read'],
    revoke: { page: 'https://acme.example/settings' },
    tools: [{
      name: 'list_tickets', upstreamName: 'list_tickets', description: 'List tickets',
      class: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
    }],
  };
  const shipped = [...HOSTED_MCP_ENTRIES];
  HOSTED_MCP_ENTRIES.push(acme);
  try {
    const linearEntry = HOSTED_MCP_ENTRIES.find((entry) => entry.id === 'linear');
    expect(linearEntry).toBeDefined();
    mockInstallables([], [
      buildHostedMcpToolInstallable(linearEntry),
      buildHostedMcpToolInstallable(acme),
    ]);
    InstallableInstallation.find.mockReturnValue(lean([]));
    Integration.find.mockReturnValue(lean([
      {
        _id: 'conn-linear', type: 'hosted-mcp', status: 'connected', createdBy: userId,
        config: { entryId: 'linear', credentialRef: 'ref-linear' },
      },
      {
        _id: 'conn-acme', type: 'hosted-mcp', status: 'connected', createdBy: userId,
        config: { entryId: 'acme', credentialRef: 'ref-acme' },
      },
    ]));

    const catalog = await catalogFor(userId);
    const rows = catalog.installables.filter((entry) => entry.list === 'tools');
    const linear = rows.find((entry) => entry.installableId === 'linear');
    const acmeRow = rows.find((entry) => entry.installableId === 'acme');

    // The descriptor the page POSTs to the start route with: the entry id is not
    // derivable from anything else the row carries.
    expect(linear).toMatchObject({ connectionType: 'hosted-mcp', entryId: 'linear', available: true, label: 'Linear' });
    expect(acmeRow).toMatchObject({ connectionType: 'hosted-mcp', entryId: 'acme' });
    expect(acmeRow.connectNotice).toBe(acme.connectNotice);
    expect(linear.connectNotice).toBeUndefined();
    expect(acmeRow.accessPage).toBe(acme.accessPage);
    expect(linear.accessPage).toBeUndefined();
    // The page a refused connect's error return may name (TASK-344): the
    // browser shows a link only when the callback's page equals this one.
    expect(acmeRow.revokePage).toBe(acme.revoke.page);
    expect(linear.revokePage).toBe(linearEntry.revoke.page);
    // Each row sees its own vendor's connection and not the other's.
    expect(linear.connections).toEqual([
      { connectionId: 'conn-linear', owner: '', repo: '' },
    ]);
    expect(acmeRow.connections).toEqual([
      { connectionId: 'conn-acme', owner: '', repo: '' },
    ]);
    expect(linear.tools).toEqual(linearEntry.tools.map((tool) => expect.objectContaining({
      name: `linear.${tool.name}`,
      description: tool.description,
      requiredWriteMode: 'read',
      irreversible: Boolean(tool.irreversible),
    })));
    expect(acmeRow.tools).toEqual([{ name: 'acme.list_tickets', description: 'List tickets', requiredWriteMode: 'read', irreversible: false }]);
    expect(Integration.find).toHaveBeenCalledWith(expect.objectContaining({
      type: { $in: ['hosted-mcp'] }, createdBy: userId, status: 'connected', revokedAt: null,
    }));
  } finally {
    HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, ...shipped);
  }
});

it("a hosted entry's connections each say how they differ: when, and for a key its hint and agent", async () => {
  const shipped = HOSTED_MCP_ENTRIES.slice();
  const linearEntry = shipped.find((entry) => entry.id === 'linear');
  try {
    mockInstallables([], [buildHostedMcpToolInstallable(linearEntry)]);
    InstallableInstallation.find.mockReturnValue(lean([]));
    Integration.find.mockReturnValue(lean([
      {
        _id: 'conn-oauth', type: 'hosted-mcp', status: 'connected', createdBy: userId,
        createdAt: new Date('2026-10-30T10:00:00Z'),
        config: { entryId: 'linear', intake: 'oauth', credentialRef: 'ref-oauth', providerSubject: 'subject-1' },
      },
      {
        _id: 'conn-key', type: 'hosted-mcp', status: 'connected', createdBy: userId,
        createdAt: new Date('2026-10-31T11:00:00Z'),
        config: { entryId: 'linear', agentId: 'agent-7', credentialHint: 'lin…9f', credentialRef: 'ref-key' },
      },
    ]));

    const catalog = await catalogFor(userId);
    const linear = catalog.installables.find((entry) => entry.list === 'tools' && entry.installableId === 'linear');

    expect(linear.connections).toEqual([
      { connectionId: 'conn-oauth', owner: '', repo: '', connectedAt: '2026-10-30T10:00:00.000Z' },
      {
        connectionId: 'conn-key', owner: '', repo: '', connectedAt: '2026-10-31T11:00:00.000Z',
        agentId: 'agent-7', credentialHint: 'lin…9f',
      },
    ]);
    expect(JSON.stringify(linear.connections)).not.toMatch(/ref-oauth|ref-key|subject-1/);
  } finally {
    HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, ...shipped);
  }
});

it('hides an instance-listed hosted entry from offerings while keeping its connection removable', async () => {
  const prior = process.env.HOSTED_MCP_HIDDEN_ENTRIES;
  process.env.HOSTED_MCP_HIDDEN_ENTRIES = '["airtable"]';
  try {
    const linear = HOSTED_MCP_ENTRIES.find((entry) => entry.id === 'linear');
    const airtable = HOSTED_MCP_ENTRIES.find((entry) => entry.id === 'airtable');
    mockInstallables([], [buildHostedMcpToolInstallable(linear), buildHostedMcpToolInstallable(airtable)]);
    InstallableInstallation.find.mockReturnValue(lean([]));
    Integration.find.mockImplementation((query) => lean(query['config.entryId']
      ? [{ _id: 'airtable-connection', type: 'hosted-mcp', status: 'disconnected', config: { entryId: 'airtable', credentialRef: 'private-credential-ref' } }]
      : []));
    const catalog = await catalogFor(userId);
    expect(catalog.installables.filter((entry) => entry.list === 'tools').map((entry) => entry.installableId)).toEqual(['linear']);
    expect(catalog.hiddenToolConnections).toEqual([{
      connectionId: 'airtable-connection', entryId: 'airtable', label: 'Airtable', status: 'disconnected',
      revokePage: 'https://airtable.com/account',
    }]);
    expect(Integration.find).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: userId, 'config.entryId': { $in: ['airtable'] },
    }));
    expect(JSON.stringify(catalog)).not.toContain('private-credential-ref');
  } finally {
    if (prior === undefined) delete process.env.HOSTED_MCP_HIDDEN_ENTRIES;
    else process.env.HOSTED_MCP_HIDDEN_ENTRIES = prior;
  }
});

it('omits an unconfigured hosted entry instead of offering a not-enabled row', async () => {
  const google = HOSTED_MCP_ENTRIES.find((entry) => entry.id === 'google-calendar');
  mockInstallables([], [buildHostedMcpToolInstallable(google)]);
  InstallableInstallation.find.mockReturnValue(lean([]));
  Integration.find.mockImplementation((query) => lean(query['config.entryId']
    ? [{ _id: 'google-connection', type: 'hosted-mcp', status: 'connected', config: { entryId: 'google-calendar' } }]
    : []));
  const priorId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const priorSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
  delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  try {
    const catalog = await catalogFor(userId);
    expect(catalog.installables.filter((entry) => entry.list === 'tools')).toEqual([]);
    expect(catalog.hiddenToolConnections).toEqual([expect.objectContaining({
      connectionId: 'google-connection', entryId: 'google-calendar', label: 'Google Calendar',
    })]);
  } finally {
    if (priorId === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
    else process.env.GOOGLE_CALENDAR_CLIENT_ID = priorId;
    if (priorSecret === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    else process.env.GOOGLE_CALENDAR_CLIENT_SECRET = priorSecret;
  }
});

it('validates the instance hidden-entry setting', () => {
  expect([...hiddenHostedMcpEntryIds({ HOSTED_MCP_HIDDEN_ENTRIES: '["airtable"]' })]).toEqual(['airtable']);
  expect([...hiddenHostedMcpEntryIds({})]).toEqual([]);
  expect(() => hiddenHostedMcpEntryIds({ HOSTED_MCP_HIDDEN_ENTRIES: 'airtable' })).toThrow();
});

it('offers a hidden hosted entry only to its configured walk user', async () => {
  const hiddenBefore = process.env.HOSTED_MCP_HIDDEN_ENTRIES;
  const allowBefore = process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST;
  process.env.HOSTED_MCP_HIDDEN_ENTRIES = '["airtable"]';
  process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST = JSON.stringify({ airtable: [userId] });
  try {
    const entry = HOSTED_MCP_ENTRIES.find((row) => row.id === 'airtable');
    mockInstallables([], [buildHostedMcpToolInstallable(entry)]);
    InstallableInstallation.find.mockReturnValue(lean([]));
    Integration.find.mockReturnValue(lean([]));
    const offerings = async (id) => (await catalogFor(id)).installables
      .filter((row) => row.list === 'tools').map((row) => row.installableId);
    expect(await offerings(userId)).toEqual(['airtable']);
    expect(await offerings('64b64c48c4f37a6b2f34c999')).toEqual([]);
    expect(await offerings(undefined)).toEqual([]);
    for (const bad of [{ airtable: [userId], typo: [userId] }, { airtable: [userId], sentry: null }]) {
      process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST = JSON.stringify(bad);
      expect(await offerings(userId)).toEqual([]);
    }
  } finally {
    if (hiddenBefore === undefined) delete process.env.HOSTED_MCP_HIDDEN_ENTRIES;
    else process.env.HOSTED_MCP_HIDDEN_ENTRIES = hiddenBefore;
    if (allowBefore === undefined) delete process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST;
    else process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST = allowBefore;
  }
});
