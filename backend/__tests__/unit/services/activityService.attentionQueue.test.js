const mockGetOpenQueue = jest.fn();
const mockPodFind = jest.fn();
const mockTaskFind = jest.fn();
const mockDecisionFind = jest.fn();
const mockDecisionCountDocuments = jest.fn();

jest.mock('../../../models/Pod', () => ({ find: (...args) => mockPodFind(...args) }));
jest.mock('../../../models/User', () => ({}));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Summary', () => ({}));
jest.mock('../../../models/Post', () => ({}));
jest.mock('../../../models/Task', () => ({ find: (...args) => mockTaskFind(...args) }));
jest.mock('../../../models/DecisionRequest', () => ({
  find: (...args) => mockDecisionFind(...args),
  countDocuments: (...args) => mockDecisionCountDocuments(...args),
}));
jest.mock('../../../services/attentionItemService', () => ({
  getOpenQueue: (...args) => mockGetOpenQueue(...args),
}));

const ActivityService = require('../../../services/activityService');
const chain = (value) => ({ select: () => ({ lean: async () => value }) });
const taskChain = (value) => ({
  select: () => ({ sort: () => ({ limit: () => ({ lean: async () => value }) }) }),
});
const decisionChain = (value) => ({
  sort: () => ({
    skip: () => ({
      limit: () => ({ lean: async () => value }),
    }),
  }),
});

describe('ActivityService.getDecisionQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the recipient-owned AttentionItem projection without a source-store fallback', async () => {
    const queue = { items: [{ id: '42', kind: 'mention' }], count: 1, composePodId: 'pod-1' };
    mockGetOpenQueue.mockResolvedValue(queue);

    await expect(ActivityService.getDecisionQueue('507f191e810c19729de860ea')).resolves.toBe(queue);
    expect(mockGetOpenQueue).toHaveBeenCalledWith('507f191e810c19729de860ea');
  });

  it('forwards scoped pagination to the queue projection', async () => {
    const queue = { items: [], count: 9, countsByPod: { 'pod-1': 9 }, remaining: 0 };
    mockGetOpenQueue.mockResolvedValue(queue);

    await expect(ActivityService.getDecisionQueue('507f191e810c19729de860ea', {
      podId: 'pod-1', limit: 50, offset: 0,
    })).resolves.toBe(queue);
    expect(mockGetOpenQueue).toHaveBeenCalledWith('507f191e810c19729de860ea', {
      podId: 'pod-1', limit: 50, offset: 0,
    });
  });

  it('reads settled decisions durably for a current pod member', async () => {
    mockPodFind.mockReturnValue(chain([{
      _id: 'pod-1', name: 'Current', createdBy: 'owner', members: [{ userId: 'member-1' }],
    }]));
    mockDecisionCountDocuments.mockResolvedValue(1);
    mockDecisionFind.mockReturnValue(decisionChain([{
      _id: 'decision-1', podId: 'pod-1', status: 'ruled', messageId: '42',
      threadRootId: '40', agentName: 'scout', title: 'Choose a path', question: 'Which?',
      options: [{ label: 'A' }, { label: 'B' }],
      ruling: { value: 'B', byUsername: 'Sam', at: new Date('2026-09-07T00:00:00Z'), messageId: '43' },
      createdAt: new Date('2026-09-06T00:00:00Z'), updatedAt: new Date('2026-09-07T00:00:00Z'),
    }]));

    const history = await ActivityService.getDecisionHistory('member-1', { podId: 'pod-1' });
    expect(history).toMatchObject({ count: 1, hasMore: false });
    expect(history.items).toEqual([expect.objectContaining({
      id: 'decision-1', kind: 'decision', podId: 'pod-1', messageId: '42',
      ruling: expect.objectContaining({ value: 'B', by: 'Sam', messageId: '43' }),
    })]);
    expect(mockPodFind).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'pod-1', $or: expect.any(Array),
    }));
    expect(mockDecisionFind).toHaveBeenCalledWith({
      podId: { $in: ['pod-1'] }, status: 'ruled', messageId: { $exists: true },
    });
    expect(mockDecisionCountDocuments).toHaveBeenCalledWith({
      podId: { $in: ['pod-1'] }, status: 'ruled', messageId: { $exists: true },
    });
  });

  it('bounds settled history to the loaded source message IDs when supplied', async () => {
    mockPodFind.mockReturnValue(chain([{
      _id: 'pod-1', name: 'Current', createdBy: 'owner', members: ['member-1'],
    }]));
    mockDecisionCountDocuments.mockResolvedValue(1);
    mockDecisionFind.mockReturnValue(decisionChain([{
      _id: 'decision-1', podId: 'pod-1', status: 'ruled', messageId: '42',
      title: 'Choose a path', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }],
      ruling: { value: 'B', byUsername: 'Sam' },
    }]));

    const history = await ActivityService.getDecisionHistory('member-1', {
      podId: 'pod-1', messageIds: ['42', '42', '  '],
    });

    expect(history).toMatchObject({ count: 1, hasMore: false });
    expect(mockDecisionFind).toHaveBeenCalledWith({
      podId: { $in: ['pod-1'] }, status: 'ruled', messageId: { $in: ['42'] },
    });
    expect(mockDecisionCountDocuments).toHaveBeenCalledWith({
      podId: { $in: ['pod-1'] }, status: 'ruled', messageId: { $in: ['42'] },
    });
  });

  it('paginates settled decisions within the selected pod instead of global overflow', async () => {
    mockPodFind.mockReturnValue(chain([{
      _id: 'pod-1', name: 'Current', createdBy: 'owner', members: ['member-1'],
    }]));
    const rows = Array.from({ length: 51 }, (_, index) => ({
      _id: `decision-${index}`, podId: 'pod-1', status: 'ruled', messageId: String(index),
      title: `Decision ${index}`, question: 'Which?', options: [{ label: 'A' }, { label: 'B' }],
      ruling: { value: 'A', byUsername: 'Sam', messageId: `reply-${index}` },
    }));
    mockDecisionCountDocuments.mockResolvedValue(51);
    mockDecisionFind.mockReturnValue(decisionChain([rows[50]]));

    const history = await ActivityService.getDecisionHistory('member-1', { podId: 'pod-1', limit: 1, offset: 50 });
    expect(history).toMatchObject({ count: 51, remaining: 0, hasMore: false });
    expect(history.items).toEqual([expect.objectContaining({ id: 'decision-50', podId: 'pod-1' })]);
  });

  it('keeps the recap fallback scoped to the requested pod', async () => {
    mockPodFind.mockReturnValue(chain([{ _id: 'pod-1', name: 'Current pod' }]));
    mockTaskFind.mockReturnValue(taskChain([]));
    mockGetOpenQueue.mockResolvedValue({
      items: [
        { id: 'first', podId: 'pod-1', createdAt: new Date() },
        { id: 'other', podId: 'pod-2', createdAt: new Date() },
      ],
      count: 2,
      composePodId: null,
    });
    const feed = jest.spyOn(ActivityService, 'getUserFeed').mockResolvedValue({ activities: [] });

    const recap = await ActivityService.getRecap('507f191e810c19729de860ea', { podId: 'pod-1' });

    expect(recap.needsYou).toEqual([expect.objectContaining({ id: 'first' })]);
    feed.mockRestore();
  });
});
