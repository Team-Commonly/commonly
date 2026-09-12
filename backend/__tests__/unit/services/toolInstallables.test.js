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
    await expect(resolveBrokerFor('github-app')).resolves.toEqual({
      installableId: 'github', brokerId: GRANT_BROKER_ID, enabledTools: brokerTools,
    });
    expect(Installable.findOne).toHaveBeenCalledWith({ installableId: 'github', source: 'builtin', status: 'active' });

    Installable.findOne.mockReturnValue({ lean: async () => null });
    await expect(resolveBrokerFor('github-app')).rejects.toMatchObject({ code: 'broker_unavailable', statusCode: 503 });
    await expect(resolveBrokerFor('gmail')).rejects.toMatchObject({ code: 'broker_unavailable' });
  });
});
