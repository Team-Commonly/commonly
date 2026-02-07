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
const registryRoutes = require('../../../routes/registry');

const getRouteHandler = (path, method) => {
  const layer = registryRoutes.stack.find((entry) => (
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
});
