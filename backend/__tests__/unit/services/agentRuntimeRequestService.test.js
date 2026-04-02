jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/Post', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
}));

jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
}));

const User = require('../../../models/User');
const Post = require('../../../models/Post');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const agentRuntimeRequestService = require('../../../services/agentRuntimeRequestService');

const createRes = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockImplementation((body) => body);
  return res;
};

describe('agentRuntimeRequestService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects non-bot users', async () => {
    User.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'user-1', isBot: false }),
    });

    const res = createRes();
    const result = await agentRuntimeRequestService.requireBotRequestContext(
      { user: { id: 'user-1' }, query: {} },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(result.error).toEqual({ message: 'This endpoint is for bot users only' });
  });

  it('resolves bot identity and installation from the request source', async () => {
    User.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'user-1',
        isBot: true,
        username: 'openclaw-worker',
        botMetadata: { agentName: 'openclaw', instanceId: 'worker' },
      }),
    });
    AgentInstallation.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        podId: 'pod-1',
        displayName: 'OpenClaw Worker',
      }),
    });

    const result = await agentRuntimeRequestService.requireBotRequestContext(
      { user: { id: 'user-1' }, body: {} },
      createRes(),
      { podId: 'pod-1', source: 'body' },
    );

    expect(AgentInstallation.findOne).toHaveBeenCalledWith({
      agentName: 'openclaw',
      podId: 'pod-1',
      instanceId: 'worker',
      status: 'active',
    });
    expect(result).toMatchObject({
      agentName: 'openclaw',
      instanceId: 'worker',
      installation: { displayName: 'OpenClaw Worker' },
    });
  });

  it('rejects bot tokens that do not match the bot username', async () => {
    User.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'user-1',
        isBot: true,
        username: 'openclaw',
      }),
    });

    const res = createRes();
    const result = await agentRuntimeRequestService.requireBotRequestContext(
      { user: { id: 'user-1' }, query: { agentName: 'other-agent' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(result.error).toEqual({ message: 'Agent token does not match bot user' });
  });

  it('builds normalized context requests with bounded limits', () => {
    expect(
      agentRuntimeRequestService.buildContextRequest(
        {
          task: 'summarize',
          summaryLimit: '99',
          assetLimit: '0',
          tagLimit: '12',
          skillLimit: '200',
          skillMode: 'HeUrIsTiC',
          skillRefreshHours: '100',
        },
        {
          podId: 'pod-1',
          userId: 'user-1',
          agentName: 'openclaw',
          instanceId: 'default',
        },
      ),
    ).toEqual({
      podId: 'pod-1',
      userId: 'user-1',
      agentContext: { agentName: 'openclaw', instanceId: 'default' },
      task: 'summarize',
      summaryLimit: 20,
      assetLimit: 1,
      tagLimit: 12,
      skillLimit: 12,
      skillMode: 'heuristic',
      skillRefreshHours: 72,
    });
  });

  it('lists active installations and loads thread metadata', async () => {
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([{ podId: 'pod-1' }]),
    });
    Post.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'thread-1', podId: 'pod-9' }),
      }),
    });

    await expect(
      agentRuntimeRequestService.listAgentInstallations('OpenClaw', 'worker'),
    ).resolves.toEqual([{ podId: 'pod-1' }]);
    await expect(agentRuntimeRequestService.loadThreadPost('thread-1')).resolves.toEqual({
      _id: 'thread-1',
      podId: 'pod-9',
    });
    expect(agentRuntimeRequestService.resolveThreadTargetPod(null, 'fallback-pod')).toBe('fallback-pod');
  });
});
