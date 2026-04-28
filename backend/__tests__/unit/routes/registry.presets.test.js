jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    findOne: jest.fn(),
    find: jest.fn(),
    getInstalledAgents: jest.fn(),
    install: jest.fn(),
  },
}));

jest.mock('../../../models/AgentProfile', () => ({}));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../models/User', () => ({}));
jest.mock('../../../models/Gateway', () => ({}));
jest.mock('../../../models/AgentTemplate', () => ({}));

jest.mock('../../../services/agentIdentityService', () => ({}));
jest.mock('../../../services/llmService', () => ({
  generateText: jest.fn(),
}));

jest.mock('../../../services/agentProvisionerService', () => ({
  listOpenClawPlugins: jest.fn(),
}));

const { listOpenClawPlugins } = require('../../../services/agentProvisionerService');
const presetsRouter = require('../../../routes/registry/presets-router');

const getRouteHandler = (path, method) => {
  const layer = presetsRouter.stack.find((entry) => (
    entry.route
    && entry.route.path === path
    && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

describe('registry presets', () => {
  const originalGemini = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  afterAll(() => {
    if (originalGemini === undefined) {
      delete process.env.GEMINI_API_KEY;
      return;
    }
    process.env.GEMINI_API_KEY = originalGemini;
  });

  it('returns preset catalog with tool and api readiness', async () => {
    const handler = getRouteHandler('/presets', 'get');
    const req = { userId: 'user-1', user: { id: 'user-1' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    listOpenClawPlugins.mockResolvedValue({
      plugins: [
        { name: 'tavily-search', spec: '@openclaw/tavily-search', version: '1.0.0' },
      ],
    });

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(Array.isArray(payload.presets)).toBe(true);
    expect(payload.presets.length).toBeGreaterThan(0);
    expect(payload.capabilities.pluginStatus).toBe('detected');
    expect(Array.isArray(payload.capabilities.plugins)).toBe(true);
    expect(payload.capabilities.llmProviders.google).toBe(true);
    expect(payload.runtimeSkills).toBeDefined();
    expect(payload.dockerCapabilities).toBeDefined();

    const researchPreset = payload.presets.find((preset) => preset.id === 'research-analyst');
    expect(researchPreset).toBeDefined();
    expect(Array.isArray(researchPreset.requiredTools)).toBe(true);
    expect(Array.isArray(researchPreset.apiRequirements)).toBe(true);
    expect(Array.isArray(researchPreset.defaultSkills)).toBe(true);
    expect(Array.isArray(researchPreset.recommendedEnv)).toBe(true);
    expect(typeof researchPreset.defaultSkills[0]?.setupStatus).toBe('string');
    expect(typeof researchPreset.readiness.ready).toBe('boolean');

    const xCuratorPreset = payload.presets.find((preset) => preset.id === 'x-curator');
    expect(xCuratorPreset).toBeDefined();
    expect(xCuratorPreset.installHints?.scopes).toEqual(expect.arrayContaining([
      'integration:read',
      'agent:messages:write',
    ]));
  });

  // Task #5 cutover (ADR-005 Stage 3 / ADR-010 Phase 3): nova HEARTBEAT delegates
  // codex tasks via DM to sam-local-codex instead of acpx_run. Lock the structural
  // invariants of the new heartbeat so future edits don't silently regress them.
  it('nova heartbeat: DM delegation surface, no acpx_run', async () => {
    const handler = getRouteHandler('/presets', 'get');
    const req = { userId: 'user-1', user: { id: 'user-1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    listOpenClawPlugins.mockResolvedValue({ plugins: [] });
    await handler(req, res);
    const novaPreset = res.json.mock.calls[0][0].presets
      .find((preset) => preset.id === 'backend-engineer');
    expect(novaPreset).toBeDefined();

    const heartbeat = novaPreset.heartbeatTemplate;
    expect(typeof heartbeat).toBe('string');

    // acpx_run only appears in retirement/negative-instruction lines (the
    // tool is still loaded in the gateway, so we tell nova not to call it
    // until Task #8 deletes it from the openclaw fork). No imperative call.
    const acpxLines = heartbeat.split('\n').filter((line) => line.includes('acpx_run'));
    for (const line of acpxLines) {
      expect(line).toMatch(/never|retir|cutover|do not|don't/i);
    }

    // The DM-delegation primitives must be present.
    expect(heartbeat).toContain('SamCodexDmPodId');
    expect(heartbeat).toContain('69efbd9c11277089b127d891'); // canonical DM podId
    expect(heartbeat).toContain('PendingDelegation');
    expect(heartbeat).toContain('sam-local-codex');

    // The five-branch decision tree labels are load-bearing.
    expect(heartbeat).toContain('Branch A');
    expect(heartbeat).toContain('Branch B');
    expect(heartbeat).toContain('Branch C');
    expect(heartbeat).toContain('Branch D');
    expect(heartbeat).toContain('Branch E');

    // SOUL.md should also call out the delegation model.
    expect(novaPreset.soulTemplate).toContain('sam-local-codex');
    expect(novaPreset.soulTemplate).not.toContain('acpx_run on the gateway');
  });
});
