jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/Task', () => ({ find: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({
  findSubstantiveAgentPodActivity: jest.fn().mockResolvedValue([]),
}));

const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');
const PGMessage = require('../../../models/pg/Message');
const Activity = require('../../../models/Activity');
const User = require('../../../models/User');
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
  let pendingApprovalsSpy;
  let userFindByIdSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    PGMessage.findSubstantiveAgentPodActivity.mockResolvedValue([]);
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
    pendingApprovalsSpy = jest.spyOn(ActivityService, 'getPendingApprovals').mockResolvedValue([]);
  });

  afterEach(() => {
    spy?.mockRestore();
    findByIdSpy?.mockRestore();
    pendingApprovalsSpy?.mockRestore();
    userFindByIdSpy?.mockRestore();
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
      podId: { $in: ['pod-1'] }, $or: expect.any(Array),
    }));
  });

  test('surfaces durable board press and decision facts ahead of incidental mentions', async () => {
    Task.find.mockReturnValue(taskQuery([
      {
        _id: 'press-1', podId: 'pod-1', taskId: 'TASK-201',
        title: 'Release the Activity recap', status: 'claimed', updatedAt: new Date(),
        updates: [{ text: 'Gated #1274 — awaiting human press.', author: 'reviewer', createdAt: new Date() }],
      },
      {
        _id: 'decision-1', podId: 'pod-1', taskId: 'TASK-202',
        title: 'DECIDE: retain unread activity state', status: 'blocked', updatedAt: new Date(),
        updates: [{ text: 'A human decision unblocks the implementation.', author: 'architect', createdAt: new Date() }],
      },
    ]));

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.needsYou).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'press', taskId: 'TASK-201', podId: 'pod-1' }),
      expect.objectContaining({ kind: 'decision', taskId: 'TASK-202', podId: 'pod-1' }),
      expect.objectContaining({ kind: 'mention', id: 'message-1' }),
    ]));
    expect(result.needsYou.map((item) => item.kind)).toEqual(['press', 'decision', 'mention']);
  });

  test('excludes system bot noise, ranks real seats by substantive updates, and only exposes active pods in the default scope', async () => {
    const activePod = { _id: 'pod-2', name: 'Real work pod', type: 'team' };
    Pod.find.mockReturnValue(podQuery([pod, activePod]));
    Task.find.mockReturnValue(taskQuery([]));
    spy.mockResolvedValue({
      activities: [
        {
          id: 'system-1', type: 'summary', actor: { id: 'system', name: 'commonly-bot', type: 'system' },
          action: 'summary', preview: 'Echoed a task update.', timestamp: new Date(),
          pod: { id: 'pod-1', name: pod.name }, flags: { isAgentAction: true, isMention: false },
        },
        {
          id: 'agent-a', type: 'message', actor: { id: 'agent-a', name: 'alpha', type: 'agent' },
          action: 'message', preview: 'Shipped one change.', timestamp: new Date(Date.now() - 60_000),
          pod: { id: 'pod-2', name: activePod.name }, flags: { isAgentAction: true, isMention: false },
        },
        {
          id: 'agent-b-1', type: 'message', actor: { id: 'agent-b', name: 'beta', type: 'agent' },
          action: 'message', preview: 'Reviewed a pull request.', timestamp: new Date(Date.now() - 120_000),
          pod: { id: 'pod-2', name: activePod.name }, flags: { isAgentAction: true, isMention: false },
        },
        {
          id: 'agent-b-2', type: 'message', actor: { id: 'agent-b', name: 'beta', type: 'agent' },
          action: 'message', preview: 'Posted the decision.', timestamp: new Date(Date.now() - 180_000),
          pod: { id: 'pod-2', name: activePod.name }, flags: { isAgentAction: true, isMention: false },
        },
      ],
    });

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.scope).toBe('active');
    expect(result.pods).toEqual([{ id: 'pod-2', name: activePod.name }]);
    expect(result.agents.map((agent) => agent.name)).toEqual(['beta', 'alpha']);
    expect(result.agents.map((agent) => agent.name)).not.toContain('commonly-bot');
  });

  test('derives the active pod selector from all substantive agent messages, not the recap feed page', async () => {
    const busyPod = { _id: 'pod-busy', name: 'Busy but active', type: 'team' };
    Pod.find.mockReturnValue(podQuery([pod, busyPod]));
    Task.find.mockReturnValue(taskQuery([]));
    spy.mockResolvedValue({ activities: [] });
    PGMessage.findSubstantiveAgentPodActivity.mockResolvedValue([{ podId: 'pod-busy' }]);

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(PGMessage.findSubstantiveAgentPodActivity).toHaveBeenCalledWith(['pod-1', 'pod-busy'], expect.any(Date));
    expect(result.pods).toEqual([{ id: 'pod-busy', name: busyPod.name }]);
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

  test('keeps a pending approval older than the recap window and absent from the sampled feed', async () => {
    spy.mockResolvedValue({ activities: [] });
    pendingApprovalsSpy.mockResolvedValue([{
      _id: 'approval-before-feed-page',
      type: 'approval_needed',
      actor: { id: 'agent-1', name: 'release-agent', type: 'agent' },
      action: 'approval_needed',
      content: 'Approve a decision that has waited longer than seven days.',
      podId: 'pod-1',
      approval: { status: 'pending' },
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    }]);

    const result = await ActivityService.getRecap(ownerId, { window: '7d' });

    expect(result.needsYou).toEqual([expect.objectContaining({
      id: 'approval-before-feed-page', kind: 'approval', podId: 'pod-1',
    })]);
  });

  test('removes a mention only after its dedicated acknowledgement is recorded', async () => {
    spy.mockResolvedValue({
      acknowledgedMentionIds: ['message-1'],
      activities: [{
        id: 'message-1',
        type: 'message',
        actor: { id: 'agent-1', name: 'sprint-impl', type: 'agent' },
        action: 'posted a message',
        preview: 'Please review this.',
        timestamp: new Date(),
        pod: { id: 'pod-1', name: pod.name },
        flags: { isAgentAction: true, isMention: true },
      }],
    });

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.needsYou).toEqual([]);
  });

  test('stores an acknowledgement separately from activity feed read-state', async () => {
    const user = {
      activityQueue: { acknowledgedMentionIds: [] },
      save: jest.fn().mockResolvedValue(),
    };
    userFindByIdSpy = jest.spyOn(User, 'findById').mockReturnValue({
      select: jest.fn().mockResolvedValue(user),
    });

    const result = await ActivityService.acknowledgeMention(ownerId, 'message-1');

    expect(result).toEqual({ success: true, acknowledgedMentionIds: ['message-1'] });
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(user).not.toHaveProperty('activityFeed');
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
