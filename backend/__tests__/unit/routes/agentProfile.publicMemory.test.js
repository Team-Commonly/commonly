jest.mock('../../../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
// Keep the model's exported constants (the profile reads them); stub the query.
jest.mock('../../../models/AgentMemory', () => ({
  AGENT_WRITABLE_SECTIONS: jest.requireActual('../../../models/AgentMemory').AGENT_WRITABLE_SECTIONS,
  findOne: jest.fn(),
}));
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
const EARLIER = 'earlier-private-wording-7f3a';

describe('public agent profile memory carries only declared, current fields', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findOne.mockReturnValue(selectLeanResult({
      _id: 'bot-user-1',
      username: 'vale',
      profilePicture: 'default',
      isBot: true,
      botMetadata: { agentName: 'vale', instanceId: 'vale' },
      agentConfig: {},
      createdAt: new Date(),
    }));
    PodAsset.find.mockReturnValue(selectLeanResult([]));
    AgentInstallation.find.mockReturnValue({
      sort: jest.fn().mockReturnValue(selectLeanResult([{ podId: 'pod-1' }])),
    });
    AgentProfile.find.mockReturnValue(selectLeanResult([]));
    Pod.find.mockReturnValue(selectLeanResult([]));
    AgentMemory.findOne.mockReturnValue(selectLeanResult({
      sections: {
        shared: {
          content: 'current public bio',
          visibility: 'public',
          updatedAt: new Date(),
          byteSize: 18,
          history: [{ content: EARLIER, replacedAt: new Date() }],
          draftNotes: 'undeclared-field-7f3a',
        },
      },
    }));
    AgentRun.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue(selectLeanResult([])) }),
    });
    PGMessage.findMostRecentPodActivity.mockResolvedValue([]);
  });

  it('returns a public section without its history', async () => {
    const res = response();
    await getProfile({ params: { agentName: 'openclaw', instanceId: 'vale' } }, res);
    expect(res.status).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.memory.sections.shared.content).toBe('current public bio');
    expect(body.memory.sections.shared).not.toHaveProperty('history');
    expect(JSON.stringify(body)).not.toContain(EARLIER);
  });

  it('returns a public section without fields the schema does not declare', async () => {
    const res = response();
    await getProfile({ params: { agentName: 'openclaw', instanceId: 'vale' } }, res);
    expect(res.status).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.memory.sections.shared.content).toBe('current public bio');
    expect(body.memory.sections.shared).not.toHaveProperty('draftNotes');
    expect(JSON.stringify(body)).not.toContain('undeclared-field-7f3a');
  });
});
