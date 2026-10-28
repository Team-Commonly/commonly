const mockUpdateOne = jest.fn();
const mockUpdateMany = jest.fn();
const mockFind = jest.fn();
const mockExists = jest.fn();
const mockPodFindById = jest.fn();
const mockPodFind = jest.fn();
const mockUserFind = jest.fn();

jest.mock('../../../models/AttentionItem', () => ({ updateOne: mockUpdateOne, updateMany: mockUpdateMany, find: mockFind, exists: mockExists }));
jest.mock('../../../models/Pod', () => ({ findById: mockPodFindById, find: mockPodFind }));
const mockTaskFind = jest.fn();
jest.mock('../../../models/Task', () => ({ find: mockTaskFind }));
const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({ find: mockUserFind, findById: mockUserFindById }));
const mockInstallationFindOne = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { findOne: mockInstallationFindOne } }));
const mockSendNeedsYouEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/needsYouEmailService', () => ({ sendNeedsYouEmail: mockSendNeedsYouEmail }));
const mockMongoMessageFindById = jest.fn();
const mockMongoMessageExists = jest.fn();
jest.mock('../../../models/Message', () => ({ findById: mockMongoMessageFindById, exists: mockMongoMessageExists }));
const mockPgMessageFindById = jest.fn();
const mockPgMessageHasReplyByUserAfter = jest.fn();
jest.mock('../../../models/pg/Message', () => ({
  findById: mockPgMessageFindById,
  hasReplyByUserAfter: mockPgMessageHasReplyByUserAfter,
}));

const mockLiveClaims = jest.fn();
jest.mock('../../../services/messageClaimService', () => ({ liveClaimsHeldBy: (...args) => mockLiveClaims(...args) }));

const chain = (value) => ({ select: () => ({ lean: async () => value }) });
const AttentionItemService = require('../../../services/attentionItemService');

describe('attentionItemService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInstallationFindOne.mockReturnValue(chain(null));
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
  });

  it('checks durable attention history without filtering by current status', async () => {
    mockExists.mockResolvedValue({ _id: 'attention-1' });

    await expect(AttentionItemService.hasEverHadAttention('recipient-1')).resolves.toBe(true);
    expect(mockExists).toHaveBeenCalledWith({ recipientUserId: 'recipient-1' });
  });

  it('treats an empty attention history as day zero', async () => {
    mockExists.mockResolvedValue(null);

    await expect(AttentionItemService.hasEverHadAttention('recipient-1')).resolves.toBe(false);
  });

  it('materializes a mention only for mentioned human members other than the author', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: ['sam', 'bot'] }));
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
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: ['sam'] }));
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

  it('routes a [BLOCKED] agent post to its installer without needing an @mention', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'creator', members: ['creator', 'sam'] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'creator', username: 'Creator', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));
    mockUserFindById.mockReturnValue(chain({
      _id: 'scout', username: 'scout', isBot: true,
      botMetadata: { displayName: 'Scout', ownerUserId: 'sam' },
    }));
    mockUpdateOne.mockResolvedValue({ upsertedId: 'attention-1' });

    await AttentionItemService.recordMentionedUsers({
      id: 45, podId: 'pod-1', userId: 'scout', content: '[BLOCKED] I need the staging key.',
    });

    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne.mock.calls[0][0].recipientUserId).toBe('sam');
    expect(mockUpdateOne.mock.calls[0][1].$setOnInsert).toMatchObject({ kind: 'blocked', title: 'Scout is blocked' });
    expect(mockSendNeedsYouEmail).toHaveBeenCalledWith(expect.objectContaining({
      recipientUserId: 'sam', actorName: 'Scout',
    }));
  });

  it('emails a decision only to the asking agent installer, not every queue recipient', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'creator', members: ['creator', 'sam'] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'creator', username: 'Creator', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));
    mockUserFindById.mockReturnValue(chain({ _id: 'scout', isBot: true, botMetadata: { ownerUserId: 'sam' } }));
    mockUpdateOne.mockResolvedValueOnce({ upsertedId: 'attention-creator' }).mockResolvedValueOnce({ upsertedId: 'attention-sam' });

    await AttentionItemService.recordDecision({
      _id: 'decision-1', podId: 'pod-1', agentUserId: 'scout', title: 'Which release?',
      options: [{ label: 'Now' }, { label: 'Later' }],
    });

    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockSendNeedsYouEmail).toHaveBeenCalledTimes(1);
    expect(mockSendNeedsYouEmail).toHaveBeenCalledWith(expect.objectContaining({ recipientUserId: 'sam' }));
  });

  it('uses the installation in this pod before a global bot owner', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', members: ['sam', 'lee'] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'sam', username: 'Sam', isBot: false },
      { _id: 'lee', username: 'Lee', isBot: false },
    ]));
    mockUserFindById.mockReturnValue(chain({
      _id: 'scout', username: 'scout', isBot: true,
      botMetadata: { ownerUserId: 'sam', agentName: 'scout' },
    }));
    mockInstallationFindOne.mockReturnValue(chain({ installedBy: 'lee' }));
    mockUpdateOne.mockResolvedValue({ upsertedId: 'attention-1' });

    await AttentionItemService.recordDecision({
      _id: 'decision-1', podId: 'pod-1', agentUserId: 'scout', agentName: 'scout',
      title: 'Which release?', options: [{ label: 'Now' }, { label: 'Later' }],
    });

    expect(mockInstallationFindOne).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'pod-1', agentName: 'scout', instanceId: 'default',
    }));
    expect(mockSendNeedsYouEmail).toHaveBeenCalledTimes(1);
    expect(mockSendNeedsYouEmail).toHaveBeenCalledWith(expect.objectContaining({ recipientUserId: 'lee' }));
  });

  it('does not re-materialize a legacy-acknowledged mention during backfill', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: ['sam'] }));
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
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: ['sam'] }));
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

  // actorUserId: actorName holds three shapes across the three
  // writers (author username, runtime agentName, nothing on decisions), so the
  // Your Team ring keys on the principal's id instead. Each writer is pinned.
  it('a mention carries its author id as actorUserId', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: ['sam'] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'owner', username: 'owner', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));
    mockUpdateOne.mockResolvedValue({ matchedCount: 0, upsertedCount: 1 });

    await AttentionItemService.recordMentionedUsers({ id: 42, podId: 'pod-1', userId: 'wren-user', username: 'Wren', content: '@sam pick one' });

    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'sam' }),
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ actorName: 'Wren', actorUserId: 'wren-user' }) }),
      expect.any(Object),
    );
  });

  it('a decision carries the agent user id as actorUserId (it has no actorName at all)', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'sam', members: ['sam'] }));
    mockUserFind.mockReturnValue(chain([{ _id: 'sam', username: 'Sam', isBot: false }]));
    mockUpdateOne.mockResolvedValue({ matchedCount: 0, upsertedCount: 1 });

    await AttentionItemService.recordDecision({ _id: 'd-1', podId: 'pod-1', agentUserId: 'kai-user', title: 'Which cursor?', options: [{ label: 'A' }, { label: 'B' }] });

    const [, update] = mockUpdateOne.mock.calls.at(-1);
    expect(update.$setOnInsert).toEqual(expect.objectContaining({ kind: 'decision', actorUserId: 'kai-user' }));
    expect(update.$setOnInsert.actorName).toBeUndefined();
  });

  it('an approval carries the requester id as actorUserId when the source has one', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'sam', members: ['sam'] }));
    mockUserFind.mockReturnValue(chain([{ _id: 'sam', username: 'Sam', isBot: false }]));
    mockUpdateOne.mockResolvedValue({ matchedCount: 0, upsertedCount: 1 });

    await AttentionItemService.recordApproval({ _id: 'a-1', podId: 'pod-1', agentMetadata: { agentName: 'openclaw' }, approval: { requestedBy: 'aria-user' }, content: 'needs repo scope' });

    const [, update] = mockUpdateOne.mock.calls.at(-1);
    expect(update.$setOnInsert).toEqual(expect.objectContaining({ kind: 'approval', actorName: 'openclaw', actorUserId: 'aria-user' }));
  });

  it('the queue item carries actorUserId as a string, and omits it when the row has none', async () => {
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [
      { _id: 'attention-1', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-1', kind: 'decision', source: { type: 'decision_request', id: 'd-1' }, title: 'Which?', actorUserId: { toString: () => 'kai-user' }, createdAt: new Date() },
      { _id: 'attention-2', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-1', kind: 'mention', source: { type: 'message', id: '41' }, title: 'Mention', createdAt: new Date() },
    ] }) });
    mockPodFind.mockReturnValue(chain([{ _id: 'pod-1', name: 'Current', createdBy: '507f191e810c19729de860ea', members: ['507f191e810c19729de860ea'] }]));

    const queue = await AttentionItemService.getOpenQueue('507f191e810c19729de860ea');
    expect(queue.items.find((item) => item.id === 'd-1').actorUserId).toBe('kai-user');
    // undefined, never a stringified 'undefined' — JSON drops it on the wire.
    expect(queue.items.find((item) => item.id === '41').actorUserId).toBeUndefined();
  });

  it('projects the source type so the page can route an action proposal to /api/approvals (#1650)', async () => {
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [
      { _id: 'attention-9', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-1', kind: 'approval', source: { type: 'approval_action', id: 'appr-1' }, title: 'Scout requests approval', createdAt: new Date() },
      { _id: 'attention-8', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-1', kind: 'approval', source: { type: 'approval', id: 'act-1' }, title: 'Access', createdAt: new Date() },
    ] }) });
    mockPodFind.mockReturnValue(chain([{ _id: 'pod-1', name: 'Current', createdBy: '507f191e810c19729de860ea', members: ['507f191e810c19729de860ea'] }]));

    const queue = await AttentionItemService.getOpenQueue('507f191e810c19729de860ea');
    expect(queue.items.find((item) => item.id === 'appr-1')).toMatchObject({ kind: 'approval', sourceType: 'approval_action' });
    expect(queue.items.find((item) => item.id === 'act-1')).toMatchObject({ kind: 'approval', sourceType: 'approval' });
  });

  it('returns only rows whose recipient is still a member and resolves by recipient-owned id', async () => {
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [
      { _id: 'attention-1', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-1', kind: 'mention', source: { type: 'message', id: '41' }, title: 'Mention', createdAt: new Date() },
      { _id: 'attention-2', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-2', kind: 'approval', source: { type: 'approval', id: 'a-1' }, title: 'Old access', createdAt: new Date() },
    ] }) });
    mockPodFind.mockReturnValue(chain([
      { _id: 'pod-1', name: 'Current', createdBy: '507f191e810c19729de860ea', members: ['507f191e810c19729de860ea'] },
      { _id: 'pod-2', name: 'Removed', createdBy: 'someone-else', members: [] },
    ]));

    const queue = await AttentionItemService.getOpenQueue('507f191e810c19729de860ea');
    expect(queue.items).toEqual([expect.objectContaining({ id: '41', attentionItemId: 'attention-1', podName: 'Current' })]);
    await AttentionItemService.acknowledgeMention('507f191e810c19729de860ea', '507f191e810c19729de860eb');
    expect(mockUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipientUserId: '507f191e810c19729de860ea', status: 'open', $or: expect.any(Array) }),
      expect.any(Object),
    );
  });

  it('serves a creator who has left the pod none of its rows', async () => {
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [
      { _id: 'attention-1', recipientUserId: '507f191e810c19729de860ea', podId: 'pod-1', kind: 'mention', source: { type: 'message', id: '41' }, title: 'A private ask', createdAt: new Date() },
    ] }) });
    mockPodFind.mockReturnValue(chain([
      { _id: 'pod-1', name: 'Left behind', createdBy: '507f191e810c19729de860ea', members: ['someone-else'] },
    ]));

    const queue = await AttentionItemService.getOpenQueue('507f191e810c19729de860ea');

    expect(queue.items).toEqual([]);
  });

  it('hides a mention when the same message already has a decision row — in any state, not only open', async () => {
    const recipient = '507f191e810c19729de860ea';
    const mention = { _id: 'attention-m', recipientUserId: recipient, podId: 'pod-1', kind: 'mention', source: { type: 'message', id: 'msg-1' }, messageId: 'msg-1', title: 'Ada mentioned you', createdAt: new Date('2026-09-01T00:00:00Z') };
    const decision = { _id: 'attention-d', recipientUserId: recipient, podId: 'pod-1', kind: 'decision', source: { type: 'decision_request', id: 'd-1' }, messageId: 'msg-1', title: 'Which?', createdAt: new Date('2026-09-01T00:00:00Z') };
    let open = [mention, decision];
    let decisionState = 'open';
    mockFind.mockImplementation((query) => (query.kind === 'decision'
      ? chain([{ _id: 'attention-d', podId: 'pod-1', messageId: 'msg-1', status: decisionState }])
      : { sort: () => ({ lean: async () => open }) }));
    mockPodFind.mockReturnValue(chain([{ _id: 'pod-1', name: 'Current', createdBy: recipient, members: [recipient] }]));

    const both = await AttentionItemService.getOpenQueue(recipient);
    expect(both.items).toEqual([expect.objectContaining({ attentionItemId: 'attention-d', kind: 'decision' })]);
    expect(both.count).toBe(1);
    expect(both.countsByKind).toEqual({ decision: 1 });
    expect(both.countsByPod).toEqual({ 'pod-1': 1 });
    // The decision row is what makes the mention redundant, so the lookup must
    // not be narrowed to open rows: a resolved decision keeps the presentation.
    expect(mockFind).toHaveBeenCalledWith({ recipientUserId: recipient, kind: 'decision', messageId: { $in: ['msg-1'] } });

    // The same message with the decision answered: the row leaves the open
    // queue and the mention must leave with it, not arrive a beat later as a
    // fresh pending item.
    decisionState = 'resolved';
    open = [mention];
    const answered = await AttentionItemService.getOpenQueue(recipient);
    expect(answered.items).toEqual([]);
    expect(answered.count).toBe(0);
    expect(answered.countsByKind).toEqual({});
  });

  it('keeps the composer target from the newest global mention beyond the page', async () => {
    const recipient = '507f191e810c19729de860ea';
    const rows = [
      ...Array.from({ length: 12 }, (_, index) => ({
        _id: `decision-${index}`, recipientUserId: recipient, podId: 'pod-1', kind: 'decision',
        source: { type: 'decision', id: `decision-${index}` }, title: `Decision ${index}`,
        createdAt: new Date(`2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`),
      })),
      {
        _id: 'mention-1', recipientUserId: recipient, podId: 'pod-2', kind: 'mention',
        source: { type: 'message', id: 'message-1' }, title: 'Mention',
        createdAt: new Date('2026-09-02T00:00:00.000Z'),
      },
    ];
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => rows }) });
    mockPodFind.mockReturnValue(chain([
      { _id: 'pod-1', name: 'Decisions', createdBy: recipient, members: [recipient] },
      { _id: 'pod-2', name: 'Mentions', createdBy: recipient, members: [recipient] },
    ]));

    const queue = await AttentionItemService.getOpenQueue(recipient, { limit: 12 });
    expect(queue.items.every((item) => item.kind === 'decision')).toBe(true);
    expect(queue.composePodId).toBe('pod-2');
    expect((await AttentionItemService.getOpenQueue(recipient, { podId: 'pod-1' })).composePodId).toBe('pod-2');
  });

  it('bounds an open queue read to the loaded source message ids when requested', async () => {
    const recipient = '507f191e810c19729de860ea';
    mockFind.mockReturnValue({ sort: () => ({ lean: async () => [] }) });
    mockPodFind.mockReturnValue(chain([]));

    await AttentionItemService.getOpenQueue(recipient, { messageIds: ['42', '42', '  '] });

    expect(mockFind).toHaveBeenCalledWith({
      recipientUserId: recipient,
      status: 'open',
      messageId: { $in: ['42'] },
    });
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
      expect.objectContaining({ status: 'open', $or: expect.any(Array) }),
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

  it('materializes an agent action proposal as an approval ask for its owner only, keyed as approval_action (#1650)', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: ['sam'] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'owner', username: 'owner', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));

    await AttentionItemService.recordActionApproval({
      _id: 'appr-1', podId: 'pod-1', ownerUserId: 'sam', agentName: 'scout', actionType: 'create_pod', summary: 'May I open a room for design work?',
    }, 'Scout');

    // Only the owner can decide it, so only the owner is asked — not both humans.
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'sam' }),
      expect.anything(),
      { upsert: true },
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'source.type': 'approval_action', 'source.id': 'appr-1' }),
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ kind: 'approval', title: 'Scout requests approval', detail: 'May I open a room for design work?' }) }),
      { upsert: true },
    );
  });

  it('an action proposal whose owner has left the pod projects nothing — no dead row for nobody (#1652)', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'sam', members: ['sam'] }));
    mockUserFind.mockReturnValue(chain([{ _id: 'sam', username: 'Sam', isBot: false }]));

    await AttentionItemService.recordActionApproval({ _id: 'appr-2', podId: 'pod-1', ownerUserId: 'gone', agentName: 'scout', summary: 'May I?' }, 'Scout');

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  // A blocked card that names nobody goes to the pod's creator, not to every
  // human in the pod: a status flip in a shared work pod used to page all of
  // them (2026-10-20 needs-you audit).
  it('materializes a blocked board row for the pod creator when the update names nobody', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: ['owner', 'sam'] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'owner', username: 'owner', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));

    await AttentionItemService.recordTaskAttention({
      _id: 'task-1', podId: 'pod-1', taskId: 'TASK-1', status: 'blocked',
      title: 'Choose a deploy shape', updates: [{ _id: 'update-1', text: 'Blocked on an upstream choice.' }],
    }, { includeBlocked: true });

    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'owner', 'source.type': 'task', 'source.id': 'task-1:update-1' }),
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ kind: 'blocked', title: 'Choose a deploy shape' }) }),
      { upsert: true },
    );
  });

  describe('a handoff asks; a report of a ruling does not', () => {
    const shipRoom = () => {
      mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: ['owner', 'sam', 'lee'] }));
      mockUserFind.mockReturnValue(chain([
        { _id: 'owner', username: 'owner', isBot: false },
        { _id: 'sam', username: 'Sam', isBot: false },
        { _id: 'lee', username: 'lee', isBot: false },
      ]));
    };
    const update = (text) => ({
      _id: 'task-2', podId: 'pod-1', taskId: 'TASK-2', status: 'pending',
      title: 'Wave 1 #1', updates: [{ _id: 'update-2', text }],
    });
    const recipients = () => mockUpdateOne.mock.calls.map(([selector]) => selector.recipientUserId);

    it("a note reporting a ruling already made opens nothing", async () => {
      shipRoom();
      // "needs" passes the cheap gate, so this reaches isHandoffRequest itself.
      await AttentionItemService.recordTaskAttention(update("Sam's ruling, 10-19 (relayed): writes are allowed when the member approves them; the Linear entry needs a re-pin."));
      expect(mockUserFind).toHaveBeenCalled();
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    it('an ask naming a human member goes to that member only', async () => {
      shipRoom();
      await AttentionItemService.recordTaskAttention(update("Awaiting @sam's call on the scope before the build."));
      expect(recipients()).toEqual(['sam']);
    });

    it('an ask of "the human" goes to the pod creator', async () => {
      shipRoom();
      await AttentionItemService.recordTaskAttention(update('Gated and green; ready for the human press.'));
      expect(recipients()).toEqual(['owner']);
    });

    it('an ask naming someone who is not a member of this pod opens nothing', async () => {
      shipRoom();
      await AttentionItemService.recordTaskAttention(update("Awaiting Bob's call before the build."));
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    it('ordinary progress prose costs no member lookup', async () => {
      shipRoom();
      await AttentionItemService.recordTaskAttention(update('Rebased onto main; CI is running.'));
      expect(mockUserFind).not.toHaveBeenCalled();
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });
  });

  describe('isHandoffRequest and handoffRecipients', () => {
    it('knows no names of its own: a name counts only when it is a member of this pod', () => {
      expect(AttentionItemService.isHandoffRequest('ready for sam', [])).toBe(false);
      expect(AttentionItemService.isHandoffRequest('ready for sam', ['Sam'])).toBe(true);
      expect(AttentionItemService.isHandoffRequest('needs lee-ops review', ['lee'])).toBe(false);
      expect(AttentionItemService.isHandoffRequest("Sam's ruling, 10-19: ship it", ['Sam'])).toBe(false);
      expect(AttentionItemService.isHandoffRequest('Waiting on a human merge press.', [])).toBe(true);
    });

    it('"human (merge) press" is an ask on its own, with no lead word and no members (only HUMAN_PRESS_RE accepts it)', () => {
      expect(AttentionItemService.isHandoffRequest('Gated and green; human merge press please.', [])).toBe(true);
      expect(AttentionItemService.isHandoffRequest('human press', [])).toBe(true);
    });

    it('with no human members left, a bare lead word is not an ask (the empty-names guard)', () => {
      // Without the guard the alternation is empty and the lookahead passes on
      // any non-word character, so these would page the creator fallback.
      expect(AttentionItemService.isHandoffRequest('awaiting .', [])).toBe(false);
      expect(AttentionItemService.isHandoffRequest('needs ', [])).toBe(false);
      expect(AttentionItemService.isHandoffRequest('awaiting .', ['', '  '])).toBe(false);
    });

    it('every accepted text passes the cheap candidate gate', () => {
      for (const text of ['ready for sam', 'Awaiting the human', 'human merge press', 'needs @lee', 'waiting for lee']) {
        expect(AttentionItemService.TASK_HANDOFF_CANDIDATE_RE.test(text)).toBe(true);
      }
    });

    it('named members first, then the creator, then everyone when the creator has left', () => {
      const members = [{ _id: 'owner', username: 'owner' }, { _id: 'sam', username: 'Sam' }];
      expect(AttentionItemService.handoffRecipients(members, 'over to @Sam', 'owner').map((m) => m._id)).toEqual(['sam']);
      expect(AttentionItemService.handoffRecipients(members, 'blocked', 'owner').map((m) => m._id)).toEqual(['owner']);
      expect(AttentionItemService.handoffRecipients(members, 'blocked', 'gone').map((m) => m._id)).toEqual(['owner', 'sam']);
    });
  });

  // createdBy keeps a departed creator's id after leavePod. Membership is
  // Pod.members alone (isListedPodMember), so the creator who left gets no
  // row from the pod they can no longer open.
  it('materializes no row for a creator who has left the pod', async () => {
    mockPodFindById.mockReturnValue(chain({ _id: 'pod-1', name: 'Ship room', createdBy: 'owner', members: ['sam'] }));
    mockUserFind.mockReturnValue(chain([
      { _id: 'owner', username: 'owner', isBot: false },
      { _id: 'sam', username: 'Sam', isBot: false },
    ]));

    await AttentionItemService.recordTaskAttention({
      _id: 'task-1', podId: 'pod-1', taskId: 'TASK-1', status: 'blocked',
      title: 'Choose a deploy shape', updates: [{ _id: 'update-1', text: 'Blocked on an upstream choice.' }],
    }, { includeBlocked: true });

    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'sam' }),
      expect.any(Object),
      { upsert: true },
    );
  });

  it('acknowledges only recipient-owned mentions and handoffs, never decisions or approvals', async () => {
    // The recipient is a real ObjectId, not a placeholder: `acknowledgeAttention`
    // refuses a caller id it cannot cast BEFORE it reaches the update, and the
    // subject of this arm is the `$or` selector, not the spelling of the id.
    await AttentionItemService.acknowledgeMention('507f191e810c19729de860ea', '507f191e810c19729de860eb');

    const selector = mockUpdateOne.mock.calls.at(-1)[0];
    expect(selector).toEqual({
      _id: '507f191e810c19729de860eb',
      recipientUserId: '507f191e810c19729de860ea',
      status: 'open',
      $or: [
        { kind: 'mention' },
        { kind: 'handoff' },
        { kind: 'blocked' },
        { kind: 'decision', 'source.type': 'task' },
      ],
    });
    expect(mockUpdateOne.mock.calls.at(-1)[1]).toEqual({
      $set: expect.objectContaining({ status: 'resolved', resolvedBy: 'acknowledged' }),
    });
  });

  it('sweeps open handoffs whose task is already done, and leaves the others (dry run counts, apply writes)', async () => {
    const chainLean = (v) => ({ sort: () => ({ lean: async () => v }), lean: async () => v, select: () => ({ lean: async () => v }) });
    // Source keys carry `task._id || task.taskId`: an ObjectId-shaped key and a
    // `TASK-134`-style key both occur, and the latter must never reach `_id`.
    const DONE = '66f000000000000000000001';
    const OPEN = '66f000000000000000000002';
    const GONE = '66f000000000000000000003';
    mockFind.mockReturnValue(chainLean([
      { _id: 'a1', source: { type: 'task', id: `${DONE}:u1` }, status: 'open' },
      { _id: 'a2', source: { type: 'task', id: `${OPEN}:u2` }, status: 'open' },
      { _id: 'a3', source: { type: 'task', id: 'TASK-134:u3' }, status: 'open' },
      { _id: 'a4', source: { type: 'task', id: `${GONE}:u4` }, status: 'open' },
    ]));
    mockTaskFind.mockReturnValue(chainLean([
      { _id: { toString: () => DONE }, status: 'done' },
      { _id: { toString: () => OPEN }, status: 'pending' },
      { _id: { toString: () => '66f000000000000000000009' }, taskId: 'TASK-134', status: 'done' },
    ]));
    const dry = await AttentionItemService.sweepDoneTaskHandoffs();
    expect(dry).toEqual({ scanned: 4, eligible: 2, resolved: 0, missing: 1, apply: false });
    expect(mockUpdateMany).not.toHaveBeenCalled();
    const [selector] = mockTaskFind.mock.calls[0];
    expect(selector).toEqual({ $or: [{ _id: { $in: [DONE, OPEN, GONE] } }, { taskId: { $in: ['TASK-134'] } }] });
    mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });
    const applied = await AttentionItemService.sweepDoneTaskHandoffs({ apply: true });
    expect(applied).toEqual({ scanned: 4, eligible: 2, resolved: 2, missing: 1, apply: true });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['a1', 'a3'] }, kind: 'handoff', status: 'open' },
      { $set: expect.objectContaining({ status: 'resolved' }) },
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

// Stickiness Phase 1b: an agent's answer to the
// person who asked opens no needs-you row. QA 10-16: a hosted agent answered 4
// plain questions and the Agents card read "needs you".
describe('an agent answering the person who asked', () => {
  const POD = 'pod-1';
  const scoutBot = { _id: 'scout-bot', username: 'scout', isBot: true, botMetadata: { agentName: 'scout', instanceId: 'u1' } };
  const members = [
    { _id: 'lee', username: 'lee', isBot: false },
    { _id: 'quinn', username: 'quinn', isBot: false },
    { _id: 'scout-bot', username: 'scout', isBot: true },
  ];
  // P (lee) wrote message 900; the agent holds the claim on it while it answers.
  const answer = (content, extra = {}) => AttentionItemService.recordMentionedUsers({
    id: 901, podId: POD, userId: 'scout-bot', username: 'Scout', content, ...extra,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockPodFindById.mockReturnValue(chain({ _id: POD, name: 'My Workspace', createdBy: 'lee', members: members.map((m) => m._id) }));
    mockUserFind.mockReturnValue(chain(members));
    mockUserFindById.mockReturnValue(chain(scoutBot));
    mockLiveClaims.mockResolvedValue(['900']);
    mockPgMessageFindById.mockImplementation(async (id) => ({
      900: { id: 900, pod_id: POD, userId: { _id: 'lee', username: 'lee' } },
      950: { id: 950, pod_id: 'pod-elsewhere', userId: { _id: 'lee', username: 'lee' } },
    })[id] || null);
  });

  const recipients = () => mockUpdateOne.mock.calls.map(([filter]) => filter.recipientUserId);

  it('four answers to four of their mentions open nothing for them', async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await answer(`@lee here is answer ${i + 1}.`);
    }
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockLiveClaims).toHaveBeenCalledWith({ podId: POD, agentName: 'scout', instanceId: 'u1' });
  });

  it('an answer that also names someone else opens a row for that person only', async () => {
    await answer('@lee done. @quinn can you take the review?');
    expect(recipients()).toEqual(['quinn']);
  });

  it('an explicit reply to their message is an answer even with no live claim', async () => {
    mockLiveClaims.mockResolvedValue([]);
    await answer('@lee here you go.', { reply_to_message_id: 900 });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  // QA walk 5 (2026-10-16): since #2269 an agent a person addressed answers even
  // when another agent won the claim, so it holds none. The native run names
  // the message it is answering, and that answers its author.
  it('an addressed agent that lost the claim answers them: no row', async () => {
    mockLiveClaims.mockResolvedValue([]);
    await answer('@lee here is the summary.', { answeringMessageId: '900' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("a run's trigger from another pod answers nobody here", async () => {
    mockLiveClaims.mockResolvedValue([]);
    await answer('@lee here is the summary.', { answeringMessageId: '950' });
    expect(recipients()).toEqual(['lee']);
  });

  it('a lapsed claim, or an unprompted ping, still opens their row', async () => {
    mockLiveClaims.mockResolvedValue([]);
    await answer('@lee the deploy failed.');
    expect(recipients()).toEqual(['lee']);
  });

  it('an answer carrying an escalation marker still opens their row', async () => {
    await answer('[BLOCKED] @lee I need the staging key to go on.');
    expect(recipients()).toEqual(['lee']);
    expect(mockLiveClaims).not.toHaveBeenCalled();
  });

  it('a human mention is unchanged', async () => {
    mockUserFindById.mockReturnValue(chain({ _id: 'quinn', username: 'quinn', isBot: false }));
    await AttentionItemService.recordMentionedUsers({ id: 902, podId: POD, userId: 'quinn', username: 'quinn', content: '@lee look at this' });
    expect(recipients()).toEqual(['lee']);
    expect(mockLiveClaims).not.toHaveBeenCalled();
  });

  it('records the row when the answer check fails: an extra row beats a lost ask', async () => {
    mockLiveClaims.mockRejectedValue(new Error('pg down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await answer('@lee here is the answer.');
    expect(recipients()).toEqual(['lee']);
    warn.mockRestore();
  });
});

describe('actioned: the recipient did what the row asked, outside its thread', () => {
  beforeEach(() => { jest.clearAllMocks(); mockUpdateMany.mockResolvedValue({ modifiedCount: 1 }); });

  it("closes a source's open rows as actioned, which Growth counts as acted on", async () => {
    await AttentionItemService.resolveActioned('message', 'msg-nudge-1');
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { 'source.type': 'message', 'source.id': 'msg-nudge-1', status: 'open' },
      { $set: { status: 'resolved', resolvedAt: expect.any(Date), resolvedBy: 'actioned' } },
    );
  });

  it('does nothing without a source id', async () => {
    await AttentionItemService.resolveActioned('message', '');
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('plain resolve() still writes no resolvedBy (approval, decision and task resolvers rely on that)', async () => {
    await AttentionItemService.resolve('approval', 'appr-1');
    expect(mockUpdateMany.mock.calls[0][1].$set).not.toHaveProperty('resolvedBy');
  });
});

describe('an agent mention nobody answered for a week leaves the queue as missed', () => {
  const NOW = new Date('2026-10-20T12:00:00Z');
  const CUTOFF = new Date('2026-10-13T12:00:00Z');

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
  });

  it("resolves an agent's week-old mention as missed and leaves a person's alone", async () => {
    mockFind.mockReturnValue(chain([{ _id: 'row-agent', actorUserId: 'bot-1' }, { _id: 'row-person', actorUserId: 'human-1' }]));
    mockUserFind.mockReturnValue(chain([{ _id: 'bot-1' }]));

    const result = await AttentionItemService.sweepMissedAgentMentions({ now: NOW });

    expect(mockUserFind).toHaveBeenCalledWith({ _id: { $in: ['bot-1', 'human-1'] }, isBot: true });
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['row-agent'] }, kind: 'mention', status: 'open' },
      { $set: { status: 'resolved', resolvedAt: NOW, resolvedBy: 'missed' } },
    );
    expect(result).toEqual({ scanned: 2, eligible: 1, missed: 1 });
  });

  it('looks only at open mentions with an actor, older than seven days by their source time', async () => {
    mockFind.mockReturnValue(chain([]));

    await AttentionItemService.sweepMissedAgentMentions({ now: NOW });

    expect(mockFind).toHaveBeenCalledWith({
      kind: 'mention',
      status: 'open',
      actorUserId: { $exists: true, $ne: null },
      $or: [
        { sourceCreatedAt: { $lt: CUTOFF } },
        { sourceCreatedAt: { $exists: false }, createdAt: { $lt: CUTOFF } },
      ],
    });
    // Nothing old enough: no actor lookup, no write.
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('a dry run counts without writing', async () => {
    mockFind.mockReturnValue(chain([{ _id: 'row-agent', actorUserId: 'bot-1' }]));
    mockUserFind.mockReturnValue(chain([{ _id: 'bot-1' }]));

    const result = await AttentionItemService.sweepMissedAgentMentions({ now: NOW, apply: false });

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, eligible: 1, missed: 0 });
  });

  it('the window is seven days', () => {
    expect(AttentionItemService.AGENT_MENTION_MISSED_DAYS).toBe(7);
  });
});
