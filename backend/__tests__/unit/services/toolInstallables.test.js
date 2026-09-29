/**
 * Tools plan §2 — the builtin GitHub tool Installable is projected from the
 * broker's own definitions, never hand-written, so the catalogue, the mint and
 * the broker can never disagree about which tools exist.
 */
jest.mock('../../../services/githubAppService', () => ({}));
jest.mock('../../../models/ToolCall', () => ({ __esModule: true, default: {}, digestArgs: jest.fn(), reserveBudgetLineage: jest.fn() }));
jest.mock('../../../models/Installable', () => ({ findOne: jest.fn() }));

const Installable = require('../../../models/Installable');
const { TOOL_DEFINITIONS } = require('../../../services/toolBrokerService');
const {
  GRANT_BROKER_ID, buildGithubToolInstallable, projectTools, mcpComponentOf, resolveBrokerFor,
} = require('../../../services/installable/toolInstallables');

const brokerTools = Object.values(TOOL_DEFINITIONS).filter((d) => d.connectionType === 'github-app').map((d) => d.name);

describe('the builtin GitHub tool Installable', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the builtin GitHub Installable enables exactly the broker\'s GitHub tools', () => {
    const installable = buildGithubToolInstallable();
    const component = mcpComponentOf(installable);
    expect(installable).toMatchObject({ installableId: 'github', source: 'builtin', kind: 'app', scope: 'pod', status: 'active' });
    expect(installable.components).toHaveLength(1);
    expect(component).toMatchObject({ type: 'mcp-server', transport: 'http', name: GRANT_BROKER_ID });
    expect(component.enabledTools).toEqual(brokerTools);
    expect(brokerTools.length).toBeGreaterThan(0);
    // Tiers and irreversibility are projected from the same definitions, so the
    // page's "what asks first" can never drift from what the broker parks.
    const projected = projectTools(component);
    expect(projected.map((t) => t.name)).toEqual(brokerTools);
    projected.forEach((tool) => {
      expect(tool.requiredWriteMode).toBe(TOOL_DEFINITIONS[tool.name].requiredWriteMode);
      expect(tool.irreversible).toBe(Boolean(TOOL_DEFINITIONS[tool.name].irreversible));
    });
    expect(JSON.stringify(installable)).not.toMatch(/GITHUB_APP_|PRIVATE_KEY|ghs_/i);
  });

  test('projectTools honours a narrowed enabledTools and ignores names the broker does not know', () => {
    const [first] = brokerTools;
    const projected = projectTools({ type: 'mcp-server', enabledTools: [first, 'github.not_a_tool'] });
    expect(projected.map((t) => t.name)).toEqual([first]);
    expect(projectTools(null)).toEqual([]);
  });

  test('resolveBrokerFor reads the broker from the seeded row and refuses when none is seeded', async () => {
    Installable.findOne.mockReturnValue({ lean: async () => buildGithubToolInstallable() });
    // The connection, not its type: a hosted row's broker depends on the row's
    // entry, so the resolver cannot take the type alone (scope §7).
    await expect(resolveBrokerFor({ type: 'github-app' })).resolves.toEqual({
      installableId: 'github', brokerId: GRANT_BROKER_ID, enabledTools: brokerTools,
    });
    expect(Installable.findOne).toHaveBeenCalledWith({ installableId: 'github', source: 'builtin', status: 'active' });

    Installable.findOne.mockReturnValue({ lean: async () => null });
    await expect(resolveBrokerFor({ type: 'github-app' })).rejects.toMatchObject({ code: 'broker_unavailable', statusCode: 503 });
    await expect(resolveBrokerFor({ type: 'gmail' })).rejects.toMatchObject({ code: 'broker_unavailable' });
  });
});

/**
 * Scope §7: a hosted-mcp connection's broker is its own catalogue ENTRY, not a
 * per-type Installable row — one entry per vendor, so keying on the type would
 * let a grant on one vendor's row name another vendor's tool. `HOSTED_MCP_ENTRIES`
 * is empty in v1, so the mechanism is witnessed against an injected catalogue.
 */
const pinned = (over) => ({
  name: 'list_issues', upstreamName: 'list_issues', description: 'List issues',
  class: 'read', inputSchema: { type: 'object' }, ...over,
});

const ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read'],
  revoke: 'https://mcp.linear.app/token',
  tools: [pinned({}), pinned({ name: 'get_issue', upstreamName: 'get_issue', description: 'Get an issue' })],
};

const OTHER_ENTRY = {
  ...ENTRY,
  id: 'acme',
  title: 'Acme',
  resource: 'https://mcp.acme.example/mcp',
  tools: [pinned({ name: 'list_tickets', upstreamName: 'list_tickets', description: 'List tickets' })],
};

const hostedRow = (entryId) => ({ type: 'hosted-mcp', config: { entryId } });

describe('resolveBrokerFor on a hosted-mcp connection', () => {
  beforeEach(() => jest.clearAllMocks());

  test("the broker is the row's own entry's tools, read from the entry and not from a seeded row", async () => {
    await expect(resolveBrokerFor(hostedRow('linear'), [ENTRY, OTHER_ENTRY])).resolves.toEqual({
      installableId: 'linear',
      brokerId: GRANT_BROKER_ID,
      enabledTools: ['linear.list_issues', 'linear.get_issue'],
    });
    // The entry is the source (§3). A seeded Installable row must not be able to
    // widen or narrow what a grant on this row may name.
    expect(Installable.findOne).not.toHaveBeenCalled();
  });

  test("a row naming another entry gets that entry's tools, so the lookup is per entry and not per type", async () => {
    await expect(resolveBrokerFor(hostedRow('acme'), [ENTRY, OTHER_ENTRY])).resolves.toMatchObject({
      installableId: 'acme',
      enabledTools: ['acme.list_tickets'],
    });
    // The inverted control for the arm above: same connection type, one field
    // different, and the tool list moves with the field.
    expect(Installable.findOne).not.toHaveBeenCalled();
  });

  test('an entry the catalogue no longer has is refused broker_unavailable, naming the entry', async () => {
    await expect(resolveBrokerFor(hostedRow('linear'), [])).rejects.toMatchObject({
      code: 'broker_unavailable', statusCode: 503,
    });
    await expect(resolveBrokerFor(hostedRow('linear'), [])).rejects.toThrow(/linear/);
    expect(Installable.findOne).not.toHaveBeenCalled();
  });

  test('a row with no entryId at all is refused, and the refusal says so rather than naming an empty string', async () => {
    for (const config of [{}, { entryId: '' }, { entryId: '  ' }]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(resolveBrokerFor({ type: 'hosted-mcp', config }, [ENTRY])).rejects.toThrow(/no hosted-mcp catalogue entry named \(none\)/);
    }
    expect(Installable.findOne).not.toHaveBeenCalled();
  });

  test('a github-app connection still reads the seeded row, so the entry path did not replace it', async () => {
    Installable.findOne.mockReturnValue({ lean: async () => buildGithubToolInstallable() });
    await expect(resolveBrokerFor({ type: 'github-app', config: {} }, [ENTRY])).resolves.toEqual({
      installableId: 'github', brokerId: GRANT_BROKER_ID, enabledTools: brokerTools,
    });
    expect(Installable.findOne).toHaveBeenCalledWith({ installableId: 'github', source: 'builtin', status: 'active' });
  });
});
