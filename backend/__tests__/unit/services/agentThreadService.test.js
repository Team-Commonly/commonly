const AgentThreadService = require('../../../services/agentThreadService');

jest.mock('../../../models/Post', () => ({
  findById: jest.fn(),
  updateOne: jest.fn(),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
}));

jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));

const Post = require('../../../models/Post');
const AgentIdentityService = require('../../../services/agentIdentityService');
const AgentEventService = require('../../../services/agentEventService');

describe('AgentThreadService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('throws when missing content', async () => {
    await expect(
      AgentThreadService.postComment({
        agentName: 'openclaw',
        threadId: 'thread-1',
        content: '',
      }),
    ).rejects.toThrow('content is required');
  });

  test('throws when thread not found', async () => {
    Post.findById.mockResolvedValueOnce(null);

    await expect(
      AgentThreadService.postComment({
        agentName: 'openclaw',
        threadId: 'missing-thread',
        content: 'hello',
      }),
    ).rejects.toThrow('Thread not found');
  });

  test('posts a new thread comment', async () => {
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({ _id: 'agent-user' });

    const save = jest.fn().mockResolvedValue();
    const post = { _id: 'thread-1', comments: [], save };
    const populatedComment = {
      _id: 'comment-1',
      text: 'hello from agent',
      userId: { username: 'openclaw' },
    };

    Post.findById
      .mockResolvedValueOnce(post)
      .mockReturnValueOnce({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ comments: [populatedComment] }),
        }),
      });

    const result = await AgentThreadService.postComment({
      agentName: 'openclaw',
      threadId: 'thread-1',
      content: 'hello from agent',
    });

    expect(save).toHaveBeenCalled();
    expect(result).toEqual({ success: true, comment: populatedComment });
  });

  describe('a reply the wrapper delivers (F225)', () => {
    const AGENT = 'agent-user';
    const commentBy = (userId, _id, replyTo = null) => ({ _id, userId, replyTo, text: 't' });
    const stubPost = (comments) => {
      const save = jest.fn().mockResolvedValue();
      const newComment = { _id: 'new-comment', userId: { _id: AGENT }, replyTo: 'target' };
      Post.updateOne.mockImplementation(async (_filter, update) => {
        comments.push(update.$push.comments);
        return { modifiedCount: 1 };
      });
      Post.findById
        .mockResolvedValueOnce({ _id: 'thread-1', comments, save })
        .mockReturnValueOnce({
          populate: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({ comments: [...comments, newComment] }),
          }),
        });
      return { save, newComment };
    };
    const reply = (extra = {}) => AgentThreadService.postComment({
      agentName: 'openclaw',
      threadId: 'thread-1',
      content: 'the answer',
      replyToCommentId: 'target',
      onlyIfUnanswered: true,
      ...extra,
    });

    beforeEach(() => {
      Post.findById.mockReset();
      Post.updateOne.mockReset();
      AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({ _id: AGENT });
    });

    test('skips when this agent already replied to that comment', async () => {
      const mine = commentBy(AGENT, 'mine', 'target');
      const { save } = stubPost([commentBy('human', 'target'), mine]);
      await expect(reply()).resolves.toEqual({ success: true, duplicate: true, comment: mine });
      expect(save).not.toHaveBeenCalled();
    });

    test('posts when the agent only spoke before that comment, or under another one', async () => {
      stubPost([
        commentBy(AGENT, 'earlier'),
        commentBy('human', 'target'),
        commentBy(AGENT, 'other-reply', 'someone-else'),
        commentBy('another-agent', 'peer', 'target'),
      ]);
      await expect(reply()).resolves.toMatchObject({ success: true, comment: { _id: 'new-comment' } });
      expect(Post.updateOne).toHaveBeenCalled();
    });

    test('the write repeats the check, and losing that race returns the reply that won it', async () => {
      const won = commentBy(AGENT, 'won', 'target');
      Post.updateOne.mockResolvedValue({ modifiedCount: 0 });
      Post.findById
        .mockResolvedValueOnce({ _id: 'thread-1', comments: [commentBy('human', 'target')], save: jest.fn() })
        .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({ comments: [commentBy('human', 'target'), won] }) });
      await expect(reply()).resolves.toEqual({ success: true, duplicate: true, comment: won });
      expect(Post.updateOne.mock.calls[0][0]).toMatchObject({
        comments: { $not: { $elemMatch: { userId: AGENT, replyTo: 'target' } } },
      });
    });

    test('a tool reply without the flag may answer the same comment twice', async () => {
      const { save } = stubPost([commentBy('human', 'target'), commentBy(AGENT, 'mine', 'target')]);
      await expect(reply({ onlyIfUnanswered: false })).resolves.toMatchObject({ success: true });
      expect(save).toHaveBeenCalled();
    });

    test.each(['NO_REPLY', 'NO_REPLY nothing to add here'])('a reply that is or opens with the sentinel stores nothing: %s', async (content) => {
      const { save } = stubPost([commentBy('human', 'target')]);
      await expect(reply({ content })).resolves.toEqual({
        success: true, skipped: true, reason: 'silent_or_empty',
      });
      expect(save).not.toHaveBeenCalled();
    });

    test('a swallowed opener leaves the same log line the chat path does', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      stubPost([commentBy('human', 'target')]);
      await reply({ content: 'NO_REPLY nothing to add here', agentName: 'seat-a' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('suppressed a reply opening with a bare sentinel'));
      expect(warn.mock.calls[0][0]).toContain('agent=seat-a');
      warn.mockRestore();
    });

    test.each([[{ text: 'hi' }], [['hi']], [42]])('non-string content is an error, not stored: %j', async (content) => {
      const { save } = stubPost([commentBy('human', 'target')]);
      await expect(reply({ content })).rejects.toThrow('content must be a string');
      expect(save).not.toHaveBeenCalled();
    });

    test('a fully fenced reply loses its outer fence, as it does in chat', async () => {
      const comments = [commentBy('human', 'target')];
      stubPost(comments);
      await reply({ content: '```\nthe answer\n```' });
      expect(comments.at(-1)).toMatchObject({ text: 'the answer' });
    });

    test('a stray sentinel inside a real reply is stripped before it is stored', async () => {
      const comments = [commentBy('human', 'target')];
      stubPost(comments);
      await reply({ content: 'the answer\nNO_REPLY' });
      expect(comments.at(-1)).toMatchObject({ text: 'the answer' });
    });

    // The wrapper's reply must not wake anyone: this path is what keeps a comment
    // @ from an agent from turning into an agent loop.
    test('an agent comment that names another agent enqueues no mention', async () => {
      stubPost([commentBy('human', 'target')]);
      await reply({ content: '@other-agent can you look?' });
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    });
  });
});
