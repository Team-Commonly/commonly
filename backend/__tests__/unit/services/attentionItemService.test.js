const mockUpdateOne = jest.fn();
const mockUpdateMany = jest.fn();
const mockFind = jest.fn();
const mockPodFindById = jest.fn();
const mockPodFind = jest.fn();
const mockUserFind = jest.fn();

jest.mock('../../../models/AttentionItem', () => ({ updateOne: mockUpdateOne, updateMany: mockUpdateMany, find: mockFind }));
jest.mock('../../../models/Pod', () => ({ findById: mockPodFindById, find: mockPodFind }));
jest.mock('../../../models/User', () => ({ find: mockUserFind }));

const chain = (value) => ({ select: () => ({ lean: async () => value }) });
const AttentionItemService = require('../../../services/attentionItemService');

describe('attentionItemService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
  });

  it('materializes a mention only for mentioned human members other than the author', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: [{ userId: 'sam' }, { userId: 'bot' }] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'owner', username: 'owner', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
      { _id: 'bot', username: 'Scout', isBot: true },
    ]));

    await AttentionItemService.recordMentionedUsers({ id: 42, podId: 'pod-1', userId: 'owner', username: 'Ada', content: '@sam please review; @samantha is different' });

    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne.mock.calls[0][0]).toEqual({ recipientUserId: 'sam', 'source.type': 'message', 'source.id': '42' });
    expect(mockUpdateOne.mock.calls[0][1].$setOnInsert).toMatchObject({ kind: 'mention', title: 'Ada mentioned you', messageId: '42' });
  });

  it('returns only rows whose recipient is still a member and resolves by recipient-owned id', async () => {
    mockFind.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [
      { _id: 'attention-1', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-1', kind: 'mention', source: { type: 'message', id: '41' }, title: 'Mention', createdAt: new Date() },
      { _id: 'attention-2', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-2', kind: 'approval', source: { type: 'approval', id: 'a-1' }, title: 'Old access', createdAt: new Date() },
    ] }) }) });
    mockPodFind.mockReturnValue(chain([
      { _id: 'pod-1', name: 'Current', createdBy: '507f191e810c19729de860ea', members: [] },
      { _id: 'pod-2', name: 'Removed', createdBy: 'someone-else', members: [] },
    ]));

    const queue = await AttentionItemService.getOpenQueue('507f191e810c19729de860ea');
    expect(queue.items).toEqual([expect.objectContaining({ id: '41', attentionItemId: 'attention-1', podName: 'Current' })]);
    await AttentionItemService.acknowledgeMention('507f191e810c19729de860ea', '507f191e810c19729de860eb');
    expect(mockUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipientUserId: '507f191e810c19729de860ea', kind: 'mention' }),
      expect.any(Object),
    );
  });

  it('does not let projection-resolution storage turn a completed source into a failure', async () => {
    mockUpdateMany.mockRejectedValueOnce(new Error('mongo unavailable'));
    await expect(AttentionItemService.resolve('approval', 'a-1')).resolves.toBeUndefined();
  });
});
