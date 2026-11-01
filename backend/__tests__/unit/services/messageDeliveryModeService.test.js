jest.mock('../../../models/Task', () => ({ find: jest.fn() }));
jest.mock('../../../services/threadWakeScopeService', () => ({ threadAuthorIds: jest.fn() }));
jest.mock('../../../services/messageClaimService', () => ({ liveClaimantsInThread: jest.fn() }));

const Task = require('../../../models/Task');
const { threadAuthorIds } = require('../../../services/threadWakeScopeService');
const MessageClaimService = require('../../../services/messageClaimService');
const {
  addressedMessageTargets, messageReferenceMatchers,
} = require('../../../services/messageDeliveryModeService');

const targets = [{ agentName: 'flint', instanceId: 'default' }, { agentName: 'sable', instanceId: 'default' }];
const botUserIds = new Map([['flint:default', 'bot-flint'], ['sable:default', 'bot-sable']]);
const classify = (content, threadRootId = null) => addressedMessageTargets({
  podId: 'pod-a', content, threadRootId, targets, botUserIds,
});

describe('ambient addressed delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Task.find.mockReturnValue({ select: () => ({ lean: jest.fn().mockResolvedValue([]) }) });
    threadAuthorIds.mockResolvedValue(new Set());
    MessageClaimService.liveClaimantsInThread.mockResolvedValue(new Set());
  });

  test('thread authors and live claimants wake only their own seat', async () => {
    threadAuthorIds.mockResolvedValue(new Set(['bot-flint']));
    MessageClaimService.liveClaimantsInThread.mockResolvedValue(new Set(['sable:default']));
    expect(await classify('ambient', 42)).toEqual(new Set(['flint:default', 'sable:default']));
    expect(MessageClaimService.liveClaimantsInThread).toHaveBeenCalledWith('pod-a', 42);
  });

  test('an exact TASK reference addresses its assignee and a live claim holder', async () => {
    Task.find.mockReturnValue({ select: () => ({ lean: jest.fn().mockResolvedValue([
      { taskId: 'TASK-414', assignee: 'flint', status: 'done' },
      { taskId: 'TASK-415', claimedBy: 'bot-sable', status: 'claimed', claimExpiresAt: new Date(Date.now() + 60000) },
    ]) }) });
    expect(await classify('TASK-414 and TASK-415')).toEqual(new Set(['flint:default', 'sable:default']));
    expect(await classify('TASK-4140')).toEqual(new Set());
    expect(messageReferenceMatchers.taskRefs('xTASK-414y')).toEqual([]);
  });

  // F45: the board stores an agent by its board name, so two agents sharing an
  // agentName are told apart by instanceId, the way the assigned-task wake matches.
  test('an assignee addresses the agent whose board name it is, not every agent sharing its agentName', async () => {
    const openclaw = [{ agentName: 'openclaw', instanceId: 'pixel' }, { agentName: 'openclaw', instanceId: 'nova' }];
    const classifyOpenclaw = (content) => addressedMessageTargets({ podId: 'pod-a', content, threadRootId: null, targets: openclaw, botUserIds: new Map() });
    Task.find.mockReturnValue({ select: () => ({ lean: jest.fn().mockResolvedValue([
      { taskId: 'TASK-501', assignee: 'pixel', status: 'pending' },
      { taskId: 'TASK-502', assignee: 'openclaw', status: 'pending' },
    ]) }) });
    expect(await classifyOpenclaw('TASK-501')).toEqual(new Set(['openclaw:pixel']));
  });

  test('a PR number matches the task prUrl exactly, not a numeric prefix', async () => {
    Task.find.mockReturnValue({ select: () => ({ lean: jest.fn().mockResolvedValue([
      { taskId: 'TASK-414', assignee: 'flint', status: 'pending', prUrl: 'https://github.com/Team-Commonly/commonly/pull/2534' },
    ]) }) });
    expect(await classify('review #2534')).toEqual(new Set(['flint:default']));
    expect(await classify('review #25345')).toEqual(new Set());
    expect(messageReferenceMatchers.prNumber('https://github.com/Team-Commonly/commonly/pull/25345'))
      .toBe('25345');
  });
});
