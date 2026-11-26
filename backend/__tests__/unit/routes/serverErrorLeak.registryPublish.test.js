jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    getByName: jest.fn(),
    create: jest.fn(),
  },
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
jest.mock('../../../models/Integration', () => ({}));
jest.mock('../../../models/AgentTemplate', () => ({}));

jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypes: jest.fn(() => ({})),
}));
jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/dmService', () => ({}));
jest.mock('../../../services/llmService', () => ({
  generateText: jest.fn(),
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  provisionAgentRuntime: jest.fn(),
  startAgentRuntime: jest.fn(),
  stopAgentRuntime: jest.fn(),
  restartAgentRuntime: jest.fn(),
  getAgentRuntimeStatus: jest.fn(),
  getAgentRuntimeLogs: jest.fn(),
}));
jest.mock('../../../utils/secret', () => ({
  hash: jest.fn(),
  randomSecret: jest.fn(),
}));
jest.mock('../../../services/agentAvatarService', () => ({ generateAvatarDetailed: jest.fn(), validateAvatar: jest.fn() }));

const { AgentRegistry } = require('../../../models/AgentRegistry');
const AgentAvatarService = require('../../../services/agentAvatarService');
const publishRouter = require('../../../routes/registry/publish');
const {
  DRIVER_TEXT, getRouteHandler, makeRes, expectNoLeak,
} = require('../../utils/routeHandler');

// F626: the publish routes answer an unexpected failure with fixed text; the
// cause goes to the server log.
let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const manifest = {
  name: 'Support-Agent', displayName: 'Support Agent', version: '1.0.0', description: 'x',
  runtime: { type: 'standalone', connection: 'rest' },
};

describe('registry publish 500s', () => {
  it('publish: a driver failure answers fixed text and logs the cause', async () => {
    AgentRegistry.getByName.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await getRouteHandler(publishRouter, '/publish', 'post')({ userId: 'u1', user: { id: 'u1' }, body: { manifest } }, res);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: 'Failed to publish agent' });
    expectNoLeak(out);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('Error publishing agent:');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('db.internal.example');
  });

  it('generate-avatar: a provider failure answers fixed text and logs the cause', async () => {
    AgentAvatarService.generateAvatarDetailed.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await getRouteHandler(publishRouter, '/generate-avatar', 'post')({ userId: 'u1', body: { agentName: 'nova' } }, res);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: 'Failed to generate avatar' });
    expectNoLeak(out);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('Avatar generation failed:');
  });

  it('a 400 we wrote still passes through', async () => {
    const { res, out } = makeRes();
    await getRouteHandler(publishRouter, '/generate-avatar', 'post')({ userId: 'u1', body: {} }, res);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: 'agentName is required' });
  });
});
