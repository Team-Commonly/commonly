const mockGetOpenQueue = jest.fn();
const mockPodFind = jest.fn();
const mockTaskFind = jest.fn();

jest.mock('../../../models/Pod', () => ({ find: (...args) => mockPodFind(...args) }));
jest.mock('../../../models/User', () => ({}));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Summary', () => ({}));
jest.mock('../../../models/Post', () => ({}));
jest.mock('../../../models/Task', () => ({ find: (...args) => mockTaskFind(...args) }));
jest.mock('../../../services/attentionItemService', () => ({
  getOpenQueue: (...args) => mockGetOpenQueue(...args),
}));

const ActivityService = require('../../../services/activityService');
const chain = (value) => ({ select: () => ({ lean: async () => value }) });
const taskChain = (value) => ({
  select: () => ({ sort: () => ({ limit: () => ({ lean: async () => value }) }) }),
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
