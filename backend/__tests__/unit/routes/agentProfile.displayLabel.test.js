jest.mock('../../../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/AgentMemory', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/AgentProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/AgentRun', () => ({ find: jest.fn() }));
jest.mock('../../../models/PodAsset', () => ({ find: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({ findMostRecentPodActivity: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { find: jest.fn() } }));
jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentDisplayLabel: jest.fn(() => 'runtime-seat'),
}));
jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => next()));

const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const AgentMemory = require('../../../models/AgentMemory');
const AgentProfile = require('../../../models/AgentProfile');
const AgentRun = require('../../../models/AgentRun');
const PodAsset = require('../../../models/PodAsset');
const PGMessage = require('../../../models/pg/Message');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { resolveAgentDisplayLabel } = require('../../../services/agentIdentityService');
const router = require('../../../routes/agentProfile');

const getHandler = (method, path) => {
  const layer = router.stack.find((entry) => (
    entry.route && entry.route.path === path && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} handler not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });
const selectLeanResult = (value) => ({ select: jest.fn().mockReturnValue(leanResult(value)) });

const getProfile = getHandler('get', '/:agentName/:instanceId?');

describe('public agent profile display label', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findOne.mockReturnValue(selectLeanResult({
      username: 'vale',
      profilePicture: 'default',
      isBot: true,
      // `agentName` is the legacy seat identifier. It must not become the
      // public runtime badge when the dedicated `runtimeId` is absent.
      botMetadata: { agentName: 'vale', instanceId: 'vale' },
      agentConfig: {},
      createdAt: new Date(),
    }));
    PodAsset.find.mockReturnValue(selectLeanResult([]));
    AgentInstallation.find.mockReturnValue({
      sort: jest.fn().mockReturnValue(selectLeanResult([{ podId: 'pod-1', displayName: 'Vale install' }])),
    });
    AgentProfile.find.mockReturnValue(selectLeanResult([{ podId: 'pod-1', name: 'Vale' }]));
    Pod.find.mockReturnValue(selectLeanResult([]));
    AgentMemory.findOne.mockReturnValue(selectLeanResult(null));
    AgentRun.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue(selectLeanResult([])) }),
    });
    PGMessage.findMostRecentPodActivity.mockResolvedValue([]);
  });

  it('prefers the active pod profile label over the raw runtime seat username', async () => {
    const res = response();

    await getProfile({ params: { agentName: 'openclaw', instanceId: 'vale' } }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ displayName: 'Vale', runtime: null }),
    }));
    expect(resolveAgentDisplayLabel).not.toHaveBeenCalled();
  });
});
