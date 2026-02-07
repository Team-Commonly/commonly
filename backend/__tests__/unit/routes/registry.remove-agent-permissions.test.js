jest.mock('../../../middleware/auth', () => (req, res, next) => next());

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    findOne: jest.fn(),
    uninstall: jest.fn(),
    find: jest.fn(),
  },
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentProfile', () => ({
  deleteOne: jest.fn(),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentType: jest.fn((agentName) => agentName),
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  removeAgentFromPod: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const AgentIdentityService = require('../../../services/agentIdentityService');
const registryRoutes = require('../../../routes/registry');

const mockRoleLookup = (role) => {
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ role }),
    }),
  });
};

const getDeleteHandler = () => {
  const deleteLayer = registryRoutes.stack.find((layer) => (
    layer.route
    && layer.route.path === '/agents/:name/pods/:podId'
    && layer.route.methods
    && layer.route.methods.delete
  ));

  if (!deleteLayer) {
    throw new Error('Delete route handler not found');
  }

  return deleteLayer.route.stack[1].handle;
};

describe('registry remove agent permissions', () => {
  const deleteHandler = getDeleteHandler();

  beforeEach(() => {
    jest.clearAllMocks();

    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'owner-1',
        members: ['member-1'],
      }),
    });

    AgentInstallation.findOne.mockResolvedValue({
      agentName: 'openclaw',
      podId: 'pod-1',
      instanceId: 'default',
      installedBy: 'installer-1',
      status: 'active',
    });

    AgentInstallation.uninstall.mockResolvedValue(true);
    AgentProfile.deleteOne.mockResolvedValue(true);
    AgentIdentityService.removeAgentFromPod.mockResolvedValue(true);
  });

  it('allows global admin to remove any agent installation from a pod', async () => {
    mockRoleLookup('admin');

    const req = {
      params: { name: 'openclaw', podId: 'pod-1' },
      query: { instanceId: 'default' },
      user: { id: 'global-admin' },
      userId: 'global-admin',
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await deleteHandler(req, res);

    expect(AgentInstallation.uninstall).toHaveBeenCalledWith('openclaw', 'pod-1', 'default');
    expect(AgentProfile.deleteOne).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('denies non-admin non-member users from removing agent installations', async () => {
    mockRoleLookup('user');

    const req = {
      params: { name: 'openclaw', podId: 'pod-1' },
      query: { instanceId: 'default' },
      user: { id: 'outsider' },
      userId: 'outsider',
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await deleteHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(AgentInstallation.uninstall).not.toHaveBeenCalled();
  });
});
