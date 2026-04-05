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
jest.mock('../../../models/Gateway', () => ({}));
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
  clearAgentRuntimeSessions: jest.fn(),
  isK8sMode: jest.fn(),
  listOpenClawPlugins: jest.fn(),
  listOpenClawBundledSkills: jest.fn(),
  installOpenClawPlugin: jest.fn(),
  writeOpenClawHeartbeatFile: jest.fn(),
  readOpenClawHeartbeatFile: jest.fn(),
  readOpenClawIdentityFile: jest.fn(),
  writeWorkspaceIdentityFile: jest.fn(),
  ensureWorkspaceIdentityFile: jest.fn(),
  syncOpenClawSkills: jest.fn(),
  resolveOpenClawAccountId: jest.fn(),
}));
jest.mock('../../../utils/secret', () => ({
  hash: jest.fn(),
  randomSecret: jest.fn(),
}));

const { AgentRegistry } = require('../../../models/AgentRegistry');
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

describe('registry publish route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores a normalized community manifest payload', async () => {
    const handler = getRouteHandler('/publish', 'post');
    const req = {
      userId: 'user-1',
      user: { id: 'user-1', username: 'nova' },
      body: {
        manifest: {
          name: 'Support-Agent',
          displayName: 'Support Agent',
          version: '1.0.0',
          description: ' Handles support questions ',
          categories: ['support', 'support'],
          tags: ['chat', 'automation'],
          runtime: {
            type: 'standalone',
            connection: 'rest',
          },
        },
        readme: 'hello',
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    AgentRegistry.getByName.mockResolvedValue(null);
    AgentRegistry.create.mockResolvedValue({
      agentName: 'support-agent',
      latestVersion: '1.0.0',
      status: 'active',
    });

    await handler(req, res);

    expect(AgentRegistry.getByName).toHaveBeenCalledWith('support-agent');
    expect(AgentRegistry.create).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'support-agent',
      displayName: 'Support Agent',
      description: 'Handles support questions',
      categories: ['support'],
      tags: ['chat', 'automation'],
      manifest: expect.objectContaining({
        name: 'support-agent',
        version: '1.0.0',
        description: 'Handles support questions',
        runtime: {
          type: 'standalone',
          connection: 'rest',
        },
      }),
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      agent: {
        name: 'support-agent',
        version: '1.0.0',
        status: 'active',
      },
    });
  });

  it('returns a 400 response when the manifest format is invalid', async () => {
    const handler = getRouteHandler('/publish', 'post');
    const req = {
      userId: 'user-1',
      user: { id: 'user-1', username: 'nova' },
      body: {
        manifest: {
          name: 'Bad Agent Name',
          version: 'draft',
        },
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Invalid agent manifest',
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'manifest.name' }),
        expect.objectContaining({ field: 'manifest.version' }),
      ]),
    }));
    expect(AgentRegistry.getByName).not.toHaveBeenCalled();
  });
});
