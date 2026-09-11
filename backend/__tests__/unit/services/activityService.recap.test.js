jest.mock('../../../models/Pod', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Task', () => ({ find: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { find: jest.fn() } }));
const mockHasMessageByUserInPods = jest.fn();
jest.mock('../../../models/pg/Message', () => ({
  hasMessageByUserInPods: (...args) => mockHasMessageByUserInPods(...args),
}));

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
const { AgentInstallation } = require('../../../models/AgentRegistry');
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
const installationQuery = (installations) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(installations) }),
});

describe('ActivityService recap and legacy approval authorization', () => {
  let feedSpy;
  let findByIdSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    Pod.find.mockReturnValue(podQuery([pod]));
    Pod.findById.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(pod) })) });
    Task.find.mockReturnValue(taskQuery([]));
    AgentInstallation.find.mockReturnValue(installationQuery([]));
    mockHasMessageByUserInPods.mockResolvedValue(false);
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

  test('closes the speak step from the account holder message, not the agent last-message field', async () => {
    AgentInstallation.find.mockReturnValue(installationQuery([
      { podId: 'pod-1', agentName: 'scout', config: {} },
    ]));
    mockHasMessageByUserInPods.mockResolvedValue(true);

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.hasSpokenToAgent).toBe(true);
    expect(mockHasMessageByUserInPods).toHaveBeenCalledWith(ownerId, ['pod-1']);
  });

  test('does not count an internal seat as an agent pod for the speak step', async () => {
    AgentInstallation.find.mockReturnValue(installationQuery([
      { podId: 'pod-1', agentName: 'hosted-smoke', config: {} },
    ]));
    mockHasMessageByUserInPods.mockResolvedValue(true);

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.hasSpokenToAgent).toBe(false);
    expect(mockHasMessageByUserInPods).not.toHaveBeenCalled();
  });

  test('does not count a human message in a pod with no agent seat', async () => {
    mockHasMessageByUserInPods.mockResolvedValue(true);

    const result = await ActivityService.getRecap(ownerId, { window: 'today' });

    expect(result.hasSpokenToAgent).toBe(false);
    expect(mockHasMessageByUserInPods).not.toHaveBeenCalled();
  });

  test('fails closed when the human-message fact is unavailable', async () => {
    AgentInstallation.find.mockReturnValue(installationQuery([
      { podId: 'pod-1', agentName: 'scout', config: {} },
    ]));
    mockHasMessageByUserInPods.mockRejectedValue(new Error('message store unavailable'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await ActivityService.getRecap(ownerId, { window: 'today' });
      expect(result.hasSpokenToAgent).toBeNull();
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
