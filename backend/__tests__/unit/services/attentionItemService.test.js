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
const mockMongoMessageFindById = jest.fn();
const mockMongoMessageExists = jest.fn();
jest.mock('../../../models/Message', () => ({ findById: mockMongoMessageFindById, exists: mockMongoMessageExists }));
const mockPgMessageFindById = jest.fn();
const mockPgMessageHasReplyByUserAfter = jest.fn();
jest.mock('../../../models/pg/Message', () => ({
  findById: mockPgMessageFindById,
  hasReplyByUserAfter: mockPgMessageHasReplyByUserAfter,
}));

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
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [
      { _id: 'attention-1', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-1', kind: 'mention', source: { type: 'message', id: '41' }, title: 'Mention', createdAt: new Date() },
      { _id: 'attention-2', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-2', kind: 'approval', source: { type: 'approval', id: 'a-1' }, title: 'Old access', createdAt: new Date() },
    ] }) });
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

  it('resolves only this recipient\'s older mentions in this pod when they post a reply', async () => {
    const result = await AttentionItemService.resolveMentionAttentionForReply({
      recipientUserId: 'sam',
      podId: 'pod-1',
      repliedAt: new Date('2026-09-06T08:00:00.000Z'),
      threadRootId: '40',
      replyToMessageId: '42',
    });

    expect(result).toBe(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: 'sam',
        podId: 'pod-1',
        kind: 'mention',
        status: 'open',
        $and: [{ $or: [{ threadRootId: '40' }, { messageId: '42' }] }],
        $or: [
          { sourceCreatedAt: { $lt: new Date('2026-09-06T08:00:00.000Z') } },
          { sourceCreatedAt: { $exists: false }, createdAt: { $lt: new Date('2026-09-06T08:00:00.000Z') } },
        ],
      }),
      { $set: expect.objectContaining({ status: 'resolved', resolvedBy: 'replied' }) },
    );
  });

  it.each([{}, { threadRootId: null, replyToMessageId: null }, { threadRootId: '', replyToMessageId: '' }])('leaves unthreaded posts open without querying Mongo: %j', async (scope) => {
    await expect(AttentionItemService.resolveMentionAttentionForReply({
      recipientUserId: 'sam', podId: 'pod-1', repliedAt: new Date(), ...scope,
    })).resolves.toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('stamps explicit acknowledgement differently from a reply', async () => {
    await AttentionItemService.acknowledgeMention('507f191e810c19729de860ea', '507f191e810c19729de860eb');

    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mention', status: 'open' }),
      { $set: expect.objectContaining({ status: 'resolved', resolvedBy: 'acknowledged' }) },
    );
  });

  it('sweeps legacy mentions only when the recipient replied after the source, with the replied stamp', async () => {
    const row = {
      _id: 'attention-1',
      recipientUserId: 'sam',
      podId: 'pod-1',
      kind: 'mention',
      source: { type: 'message', id: '42' },
      messageId: '42', threadRootId: '40',
      createdAt: new Date('2026-09-05T10:00:00.000Z'),
    };
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [row] }) });
    mockPgMessageFindById.mockResolvedValue({ createdAt: new Date('2026-09-05T09:00:00.000Z') });
    mockPgMessageHasReplyByUserAfter.mockResolvedValue(true);

    const result = await AttentionItemService.sweepResolvedMentionAttention({ apply: true });

    expect(result).toEqual({ scanned: 1, eligible: 1, resolved: 1, unavailable: 0 });
    expect(mockPgMessageHasReplyByUserAfter).toHaveBeenCalledWith(
      'pod-1', 'sam', new Date('2026-09-05T09:00:00.000Z'),
      { messageId: '42', threadRootId: '40' },
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'attention-1', kind: 'mention', status: 'open' },
      { $set: expect.objectContaining({ status: 'resolved', resolvedBy: 'replied', sourceCreatedAt: new Date('2026-09-05T09:00:00.000Z') }) },
    );
  });

  it('keeps Mongo fallback mentions open when no reply edges are persisted', async () => {
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [{
      _id: 'attention-mongo', source: { type: 'message', id: '507f191e810c19729de860ea' },
      sourceCreatedAt: new Date('2026-01-01'), podId: 'pod-1', recipientUserId: 'sam',
    }] }) });
    const result = await AttentionItemService.sweepResolvedMentionAttention({ apply: true });
    expect(result).toMatchObject({ eligible: 0, resolved: 0 });
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockMongoMessageExists).not.toHaveBeenCalled();
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
