const mockUpdateOne = jest.fn();
const mockUpdateMany = jest.fn();
const mockFind = jest.fn();
const mockPodFindById = jest.fn();
const mockPodFind = jest.fn();
const mockUserFind = jest.fn();

jest.mock('../../../models/AttentionItem', () => ({ updateOne: mockUpdateOne, updateMany: mockUpdateMany, find: mockFind }));
jest.mock('../../../models/Pod', () => ({ findById: mockPodFindById, find: mockPodFind }));
const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({ find: mockUserFind, findById: mockUserFindById }));

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

  it('names the author from the User row when the message carries only user_id (PG rows)', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: [{ userId: 'sam' }] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'owner', username: 'owner', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));
    mockUserFindById.mockReturnValue(chain({ _id: 'owner', username: 'ada', botMetadata: { displayName: 'Ada Lovelace' } }));
    await AttentionItemService.recordMentionedUsers({ id: 43, pod_id: 'pod-1', user_id: 'owner', content: '@sam one more' });
    expect(mockUserFindById).toHaveBeenCalledWith('owner');
    expect(mockUpdateOne.mock.calls[0][1].$setOnInsert).toMatchObject({ title: 'Ada Lovelace mentioned you', actorName: 'Ada Lovelace' });
  });

  it('does not read pod membership for a message with no mention marker', async () => {
    await AttentionItemService.recordMentionedUsers({
      id: 42, podId: 'pod-1', userId: 'owner', username: 'Ada', content: 'ordinary status update',
    });

    expect(mockPodFindById).not.toHaveBeenCalled();
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('does not re-materialize a legacy-acknowledged mention during backfill', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: [{ userId: 'sam' }] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'owner', username: 'owner', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));

    await AttentionItemService.recordMentionedUsers(
      { id: 42, podId: 'pod-1', userId: 'owner', username: 'Ada', content: '@sam please review' },
      { isAlreadyAcknowledged: (recipient, id) => recipient === 'sam' && id === 'msg_42' },
    );

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('does not resurrect a resolved attention row when its source write is retried', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: [{ userId: 'sam' }] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'owner', username: 'owner', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));
    const rows = [];
    mockUpdateOne.mockImplementation(async (filter, update) => {
      const row = rows.find((candidate) => (
        candidate.recipientUserId === filter.recipientUserId
        && candidate.source.type === filter['source.type']
        && candidate.source.id === filter['source.id']
      ));
      if (row) {
        if (update.$set) Object.assign(row, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      }
      rows.push({ ...update.$setOnInsert });
      return { upsertedCount: 1 };
    });
    const message = { id: 42, podId: 'pod-1', userId: 'owner', username: 'Ada', content: '@sam please review' };

    await AttentionItemService.recordMentionedUsers(message);
    rows[0].status = 'resolved';
    await AttentionItemService.recordMentionedUsers(message);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'resolved', source: { type: 'message', id: '42' } });
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

  it('materializes a blocked board row once for each current human recipient', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: [{ userId: 'sam' }] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'owner', username: 'owner', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));

    await AttentionItemService.recordTaskAttention({
      _id: 'task-1', podId: 'pod-1', taskId: 'TASK-1', status: 'blocked',
      title: 'Choose a deploy shape', updates: [{ _id: 'update-1', text: 'Blocked on an upstream choice.' }],
    }, { includeBlocked: true });

    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'source.type': 'task', 'source.id': 'task-1:update-1' }),
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ kind: 'decision', title: 'Choose a deploy shape' }) }),
      { upsert: true },
    );
  });

  it('resolves every outstanding fact for a task once the task no longer needs a human', async () => {
    await AttentionItemService.resolveTaskAttention({ _id: 'task.1' });

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        'source.type': 'task',
        'source.id': expect.objectContaining({ $regex: expect.any(RegExp) }),
      }),
      expect.any(Object),
    );
    const sourcePattern = mockUpdateMany.mock.calls[0][0]['source.id'].$regex;
    expect(sourcePattern.test('task.1:update-1')).toBe(true);
    expect(sourcePattern.test('taskx1:update-1')).toBe(false);
  });
});
