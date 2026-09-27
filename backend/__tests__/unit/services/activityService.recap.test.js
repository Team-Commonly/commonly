jest.mock('../../../models/Pod', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Task', () => ({ find: jest.fn() }));

const mockGetOpenQueue = jest.fn();
const mockHasEverHadAttention = jest.fn();
const mockAcknowledgeAttention = jest.fn();
const mockResolve = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  getOpenQueue: (...args) => mockGetOpenQueue(...args),
  hasEverHadAttention: (...args) => mockHasEverHadAttention(...args),
  acknowledgeAttention: (...args) => mockAcknowledgeAttention(...args),
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
    mockHasEverHadAttention.mockResolvedValue(false);
    mockAcknowledgeAttention.mockResolvedValue({ success: true });
    mockResolve.mockResolvedValue(undefined);
    feedSpy = jest.spyOn(ActivityService, 'getUserFeed').mockResolvedValue({ activities: [] });
  });

  afterEach(() => {
    feedSpy?.mockRestore();
    findByIdSpy?.mockRestore();
  });

  test('builds the viewer\'s pod list from membership, not from createdBy', async () => {
    await ActivityService.getRecap(ownerId, { window: 'today' });

    // The membership decision for this reader is in the query, so the arm
    // asserts the term the change removes rather than a row — the Pod mock
    // returns whichever fixture it is handed. `createdBy` is written once at
    // creation and survives `leavePod`, so reading it here handed a departed
    // creator the recap of a pod they are no longer in.
    expect(Pod.find.mock.calls[0][0]).toEqual({
      $or: [
        { 'members.userId': ownerId },
        { members: ownerId },
      ],
    });
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
    expect(result.hasEverHadAttention).toBe(false);
    expect(mockGetOpenQueue).toHaveBeenCalledWith(ownerId);
  });

  test('returns the durable ever-had-attention fact for the account', async () => {
    mockHasEverHadAttention.mockResolvedValue(true);

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.hasEverHadAttention).toBe(true);
    expect(mockHasEverHadAttention).toHaveBeenCalledWith(ownerId);
  });

  test('keeps day-zero onboarding gated when the durable history check fails', async () => {
    mockHasEverHadAttention.mockRejectedValue(new Error('history unavailable'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await ActivityService.getRecap(ownerId, { window: 'today' });
      expect(result.hasEverHadAttention).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('acknowledges attention only through the recipient-owned attention record', async () => {
    await expect(ActivityService.acknowledgeMention(ownerId, 'attention-1')).resolves.toEqual({ success: true });
    expect(mockAcknowledgeAttention).toHaveBeenCalledWith(ownerId, 'attention-1');
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

  // TASK-166: the read rule and this gate move together. A non-member arm
  // cannot see the creator clause at all — only a creator can — so this is the
  // arm that distinguishes the two predicates.
  test('fails closed when the pod\'s creator has left it', async () => {
    const storedApproval = new Activity({ type: 'approval_needed', action: 'approval_needed', podId: pod._id });
    const approve = jest.fn().mockResolvedValue();
    storedApproval.approve = approve;
    findByIdSpy = jest.spyOn(Activity, 'findById').mockResolvedValue(storedApproval);
    Pod.findById.mockReturnValue({
      select: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: ownerId, members: ['member-1'] }),
      })),
    });

    await expect(ActivityService.approveActivity(String(storedApproval._id), ownerId, 'Approved'))
      .resolves.toEqual({ success: false, status: 403, error: 'Only pod members can decide this' });
    expect(approve).not.toHaveBeenCalled();
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
