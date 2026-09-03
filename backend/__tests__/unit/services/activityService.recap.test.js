jest.mock('../../../models/Pod', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Task', () => ({ find: jest.fn() }));

const mockGetOpenQueue = jest.fn();
const mockAcknowledgeMention = jest.fn();
const mockResolve = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  getOpenQueue: (...args) => mockGetOpenQueue(...args),
  acknowledgeMention: (...args) => mockAcknowledgeMention(...args),
  resolve: (...args) => mockResolve(...args),
}));

const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');
const Activity = require('../../../models/Activity');
const ActivityService = require('../../../services/activityService');

const ownerId = 'owner-1';
const pod = {
  _id: 'pod-1', name: 'Activity source pod', type: 'team', createdBy: ownerId, members: [ownerId, 'member-1'],
};

const podQuery = (pods) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(pods) }) });
const taskQuery = (tasks) => ({
  select: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(tasks) }) }),
  }),
});

describe('ActivityService recap and legacy approval authorization', () => {
  let feedSpy;
  let findByIdSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    Pod.find.mockReturnValue(podQuery([pod]));
    Pod.findById.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(pod) })) });
    Task.find.mockReturnValue(taskQuery([]));
    mockGetOpenQueue.mockResolvedValue({ items: [], count: 0, composePodId: null });
    mockAcknowledgeMention.mockResolvedValue({ success: true });
    mockResolve.mockResolvedValue(undefined);
    feedSpy = jest.spyOn(ActivityService, 'getUserFeed').mockResolvedValue({ activities: [] });
  });

  afterEach(() => {
    feedSpy?.mockRestore();
    findByIdSpy?.mockRestore();
  });

  test('rejects a requested pod that is outside the viewer membership', async () => {
    await expect(ActivityService.getRecap(ownerId, { podId: 'not-a-member-pod' }))
      .rejects.toThrow('Access denied');
  });

  test('does not mistake the approval.status default on an ordinary message for a request', async () => {
    const storedMessage = new Activity({ type: 'message', action: 'posted a message', content: 'An ordinary update.' });
    expect(storedMessage.approval.status).toBe('pending');
    feedSpy.mockResolvedValue({
      activities: [{
        id: 'message-with-defaulted-approval', type: 'message',
        actor: { id: 'human-1', name: 'A human', type: 'human' }, action: 'posted a message',
        preview: 'An ordinary update.', timestamp: new Date(), pod: { id: 'pod-1', name: pod.name },
        approval: storedMessage.approval.toObject(), flags: { isAgentAction: false, isMention: false },
      }],
    });

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.needsYou).toEqual([]);
    expect(mockGetOpenQueue).toHaveBeenCalledWith(ownerId);
  });

  test('acknowledges a mention only through the recipient-owned attention record', async () => {
    await expect(ActivityService.acknowledgeMention(ownerId, 'attention-1')).resolves.toEqual({ success: true });
    expect(mockAcknowledgeMention).toHaveBeenCalledWith(ownerId, 'attention-1');
  });

  test('allows a pod member to approve a legacy Activity approval', async () => {
    const storedApproval = new Activity({ type: 'approval_needed', action: 'approval_needed', podId: pod._id });
    const approve = jest.fn().mockResolvedValue();
    storedApproval.approve = approve;
    findByIdSpy = jest.spyOn(Activity, 'findById').mockResolvedValue(storedApproval);

    await expect(ActivityService.approveActivity(String(storedApproval._id), 'member-1', 'Approved'))
      .resolves.toEqual({ success: true, status: 'approved' });
    expect(approve).toHaveBeenCalledWith('member-1', 'Approved');
    expect(mockResolve).toHaveBeenCalledWith('approval', storedApproval._id);
  });

  test('fails closed when a non-member attempts a legacy Activity approval', async () => {
    const storedApproval = new Activity({ type: 'approval_needed', action: 'approval_needed', podId: pod._id });
    const approve = jest.fn().mockResolvedValue();
    storedApproval.approve = approve;
    findByIdSpy = jest.spyOn(Activity, 'findById').mockResolvedValue(storedApproval);

    await expect(ActivityService.approveActivity(String(storedApproval._id), 'non-member', 'Nope'))
      .resolves.toEqual({ success: false, status: 403, error: 'Only pod members can decide this' });
    expect(approve).not.toHaveBeenCalled();
  });

  test('fails closed when a non-member attempts a legacy Activity rejection', async () => {
    const storedApproval = new Activity({ type: 'approval_needed', action: 'approval_needed', podId: pod._id });
    const reject = jest.fn().mockResolvedValue();
    storedApproval.reject = reject;
    findByIdSpy = jest.spyOn(Activity, 'findById').mockResolvedValue(storedApproval);

    await expect(ActivityService.rejectActivity(String(storedApproval._id), 'non-member', 'Nope'))
      .resolves.toEqual({ success: false, status: 403, error: 'Only pod members can decide this' });
    expect(reject).not.toHaveBeenCalled();
  });
});
