jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/Task', () => ({ find: jest.fn() }));

const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');
const Activity = require('../../../models/Activity');
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
  let findByIdSpy;

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

  afterEach(() => {
    spy?.mockRestore();
    findByIdSpy?.mockRestore();
  });

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

  test('does not mistake the approval.status default on an ordinary message for a request', async () => {
    // Build the stored document with the real schema. Its nested default is
    // the production condition that caused every ordinary activity to be
    // projected as an approval; a hand-written missing approval field would
    // not reproduce it.
    const storedMessage = new Activity({
      type: 'message',
      action: 'posted a message',
      content: 'An ordinary update.',
    });
    expect(storedMessage.approval.status).toBe('pending');
    spy.mockResolvedValue({
      activities: [{
        id: 'message-with-defaulted-approval',
        type: 'message',
        actor: { id: 'human-1', name: 'A human', type: 'human' },
        action: 'posted a message',
        preview: 'An ordinary update.',
        timestamp: new Date(),
        pod: { id: 'pod-1', name: pod.name },
        approval: storedMessage.approval.toObject(),
        flags: { isAgentAction: false, isMention: false },
      }],
    });

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.needsYou).toEqual([]);
  });

  test('keeps an actual pending approval in the decision queue', async () => {
    spy.mockResolvedValue({
      activities: [{
        id: 'approval-1',
        type: 'approval_needed',
        actor: { id: 'agent-1', name: 'release-agent', type: 'agent' },
        action: 'approval_needed',
        preview: 'Approve access to Production.',
        timestamp: new Date(),
        pod: { id: 'pod-1', name: pod.name },
        approval: { status: 'pending' },
        flags: { isAgentAction: true, isMention: false },
      }],
    });

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.needsYou).toEqual([expect.objectContaining({
      id: 'approval-1', kind: 'approval', title: 'Approval requested',
    })]);
  });

  test('projects only an approval that the existing approve writer accepts', async () => {
    const storedApproval = new Activity({
      type: 'approval_needed',
      action: 'approval_needed',
      content: 'Approve the release.',
    });
    const approve = jest.fn().mockResolvedValue();
    storedApproval.approve = approve;
    spy.mockResolvedValue({
      activities: [{
        id: String(storedApproval._id),
        type: storedApproval.type,
        actor: { id: 'agent-1', name: 'release-agent', type: 'agent' },
        action: storedApproval.action,
        preview: storedApproval.content,
        timestamp: new Date(),
        pod: { id: 'pod-1', name: pod.name },
        approval: storedApproval.approval.toObject(),
        flags: { isAgentAction: true, isMention: false },
      }],
    });
    const recap = await ActivityService.getRecap(ownerId, { window: 'today' });
    findByIdSpy = jest.spyOn(Activity, 'findById').mockResolvedValue(storedApproval);

    const result = await ActivityService.approveActivity(recap.needsYou[0].id, ownerId, 'Approved in Activity');

    expect(result).toEqual({ success: true, status: 'approved' });
    expect(approve).toHaveBeenCalledWith(ownerId, 'Approved in Activity');
  });
});
