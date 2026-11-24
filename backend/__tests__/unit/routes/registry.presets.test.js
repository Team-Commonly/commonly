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
jest.mock('../../../models/AgentTemplate', () => ({}));

jest.mock('../../../services/agentIdentityService', () => ({}));
jest.mock('../../../services/llmService', () => ({
  generateText: jest.fn(),
}));

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

  it('no preset names a skill whose requirements its runtime lacks', () => {
    // A preset skill lands in the pod's skills and reaches its agents, so a
    // skill that needs a shell, a binary or an OpenClaw tool its runtime lacks
    // hands agents commands that fail (F413, F418). The catalog skills come
    // from ClawHub, so their needs are written down here from each SKILL.md.
    // A skill missing from this map fails the test until someone classifies it.
    const { PRESET_DEFINITIONS } = require('../../../routes/registry/presets');
    const CATALOG_NEEDS = {
      weather: ['shell'], // curl wttr.in / open-meteo
      trello: ['shell'], // curl + jq against api.trello.com
      'video-frames': ['shell'], // bundled frame.sh + ffmpeg
      'openai-whisper-api': ['shell'], // bundled transcribe.sh + curl
      tavily: ['shell'], // bundled tavily_search.py + pip tavily-python
      slack: ['openclaw-tool'], // the gateway's built-in slack tool
      discord: ['openclaw-tool'], // the gateway's built-in discord tool
    };
    // The gateway (openclaw) is retired and the native runtime (internal) has
    // no shell. A runtime earns a capability here only once it really has it.
    const RUNTIME_HAS = { openclaw: [], internal: [], webhook: [], 'claude-code': [] };
    const needsOf = (id) => CATALOG_NEEDS[id] || null;
    const problemsIn = (presets) => presets.flatMap((preset) => {
      const has = RUNTIME_HAS[preset.installHints?.runtime] || [];
      return (preset.defaultSkills || []).flatMap((skill) => {
        const needs = needsOf(skill.id);
        if (!needs) return [`${preset.id}:${skill.id} (unclassified)`];
        return needs.filter((need) => !has.includes(need)).map((need) => `${preset.id}:${skill.id} needs ${need}`);
      });
    });
    // The check bites: a shell skill on the gateway and an unknown skill both fail.
    expect(problemsIn([{
      id: 'probe',
      installHints: { runtime: 'openclaw' },
      defaultSkills: [{ id: 'tavily' }, { id: 'no-such-skill' }],
    }])).toEqual(['probe:tavily needs shell', 'probe:no-such-skill (unclassified)']);
    expect(problemsIn(PRESET_DEFINITIONS)).toEqual([]);
  });

  it('no openclaw preset tells its agent to reach for the gh skill', () => {
    // The gateway that carried gh is retired and the github skill left the
    // presets (F413), so an "Or `gh` ..." line points at a tool that is gone
    // (F416). Presets that delegate gh to a coding runtime say so explicitly.
    const { PRESET_DEFINITIONS } = require('../../../routes/registry/presets');
    const offenders = PRESET_DEFINITIONS
      .filter((preset) => /Or `gh`/.test(`${preset.heartbeatTemplate || ''}\n${preset.soulTemplate || ''}`))
      .map((preset) => preset.id);
    expect(offenders).toEqual([]);
  });

  it('no preset PATCHes a task to claimed, because a seat cannot PATCH a claim', () => {
    const { PRESET_DEFINITIONS } = require('../../../routes/registry/presets');
    const serialized = JSON.stringify(PRESET_DEFINITIONS);
    // A status written as a key or a value, plain or JSON-escaped: `status: \"claimed\"`,
    // `\"status\":\"claimed\"`, `status=claimed`. The old pattern missed the last two.
    const claimedWrite = /\bstatus\W{1,6}(?:claimed|in_progress|in-progress|inprogress)\b/i;
    // The matcher must catch the spellings it promises, or the absence check below is vacuous.
    ['status: "claimed"', '"status":"claimed"', 'status=claimed', '{ status: "in_progress" }']
      .forEach((sample) => expect(claimedWrite.test(sample)).toBe(true));
    expect(claimedWrite.test(serialized)).toBe(false);
  });

  // ADR-021: the 29 OpenClaw presets left with the backend driver.
  it('keeps only the presets a live runtime installs', () => {
    const { PRESET_DEFINITIONS } = require('../../../routes/registry/presets');
    expect(PRESET_DEFINITIONS.map((preset) => preset.id)).toEqual([
      'autonomy-curator', 'social-amplifier', 'claude-code-agent', 'webhook-agent',
    ]);
    expect(PRESET_DEFINITIONS.filter((preset) => preset.agentName === 'openclaw')).toEqual([]);
  });

  it('returns preset catalog with tool and api readiness', async () => {
    const handler = getRouteHandler('/presets', 'get');
    const req = { userId: 'user-1', user: { id: 'user-1' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(Array.isArray(payload.presets)).toBe(true);
    expect(payload.presets.length).toBeGreaterThan(0);
    expect(payload.capabilities.llmProviders.google).toBe(true);
    expect(payload.capabilities.plugins).toBeUndefined();
    expect(payload.runtimeSkills).toBeUndefined();
    expect(payload.dockerCapabilities).toBeUndefined();

    const amplifier = payload.presets.find((preset) => preset.id === 'social-amplifier');
    expect(amplifier).toBeDefined();
    expect(Array.isArray(amplifier.requiredTools)).toBe(true);
    amplifier.requiredTools.forEach((tool) => expect(typeof tool.available).toBe('boolean'));
    expect(Array.isArray(amplifier.apiRequirements)).toBe(true);
    expect(Array.isArray(amplifier.recommendedEnv)).toBe(true);
    expect(typeof amplifier.readiness.ready).toBe('boolean');
    expect(amplifier.installHints?.scopes).toEqual(expect.arrayContaining([
      'integration:read',
      'agent:messages:write',
    ]));
  });

  it('uses Slack manifest readiness instead of the legacy bot token check', async () => {
    const handler = getRouteHandler('/presets', 'get');
    const req = { userId: 'user-1', user: { id: 'user-1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const readinessKeys = [
      'SLACK_BOT_TOKEN',
      'SLACK_CLIENT_ID',
      'SLACK_CLIENT_SECRET',
      'SLACK_SIGNING_SECRET',
      'CONNECTOR_SECRET_KEYS',
      'CONNECTOR_SECRET_ACTIVE_KEY',
    ];
    const previous = Object.fromEntries(readinessKeys.map((key) => [key, process.env[key]]));

    try {
      readinessKeys.forEach((key) => delete process.env[key]);
      process.env.SLACK_BOT_TOKEN = 'legacy-bot-token';

      await handler(req, res);
      expect(res.json.mock.calls[0][0].capabilities.integrations.slack).toBe(false);

      readinessKeys.slice(1).forEach((key) => {
        process.env[key] = 'configured';
      });
      const configuredRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await handler(req, configuredRes);
      expect(configuredRes.json.mock.calls[0][0].capabilities.integrations.slack).toBe(true);
    } finally {
      readinessKeys.forEach((key) => {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      });
    }
  });
});
