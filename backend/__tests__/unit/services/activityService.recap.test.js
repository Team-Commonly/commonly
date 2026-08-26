jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/Task', () => ({ find: jest.fn() }));

const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');
const ActivityService = require('../../../services/activityService');

const ownerId = 'owner-1';
const pod = { _id: 'pod-1', name: 'Activity source pod', type: 'team' };

const podQuery = (pods) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(pods) }),
});

const taskQuery = (tasks) => ({
  select: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(tasks) }),
    }),
  }),
});

describe('ActivityService.getRecap', () => {
  let spy;

  beforeEach(() => {
    jest.clearAllMocks();
    Pod.find.mockReturnValue(podQuery([pod]));
    Task.find.mockReturnValue(taskQuery([{
      _id: 'board-1',
      podId: 'pod-1',
      taskId: 'TASK-068',
      title: 'Activity tab',
      status: 'claimed',
      updatedAt: new Date(),
      updates: [{ text: 'Implementation began.', author: 'sprint-impl', createdAt: new Date() }],
    }]));
    spy = jest.spyOn(ActivityService, 'getUserFeed').mockResolvedValue({
      activities: [{
        id: 'message-1',
        type: 'message',
        actor: { id: 'agent-1', name: 'sprint-impl', type: 'agent' },
        action: 'posted a message',
        preview: 'Checks passed.',
        timestamp: new Date(),
        pod: { id: 'pod-1', name: pod.name },
        flags: { isAgentAction: true, isMention: true },
      }],
    });
  });

  afterEach(() => { spy?.mockRestore(); });

  test('projects existing agent activity, direct mentions, and board updates without writing new events', async () => {
    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.pods).toEqual([expect.objectContaining({ id: 'pod-1', name: pod.name })]);
    expect(result.needsYou).toEqual([expect.objectContaining({
      kind: 'mention', podId: 'pod-1', title: 'sprint-impl mentioned you',
    })]);
    expect(result.agents).toEqual([expect.objectContaining({
      id: 'agent-1', name: 'sprint-impl', messageCount: 1,
      updates: [expect.objectContaining({ content: 'Checks passed.' })],
    })]);
    expect(result.board).toEqual([expect.objectContaining({
      taskId: 'TASK-068', title: 'Activity tab', status: 'claimed',
      lastUpdate: expect.objectContaining({ text: 'Implementation began.' }),
    })]);
    expect(spy).toHaveBeenCalledWith(ownerId, { limit: 100 });
    expect(Pod.find).toHaveBeenCalledWith(expect.objectContaining({ $or: expect.any(Array) }));
    expect(Task.find).toHaveBeenCalledWith(expect.objectContaining({
      podId: { $in: ['pod-1'] }, updatedAt: { $gte: expect.any(Date) },
    }));
  });

  test('rejects a requested pod that is outside the viewer membership', async () => {
    await expect(ActivityService.getRecap(ownerId, { podId: 'not-a-member-pod' }))
      .rejects.toThrow('Access denied');
  });
});
