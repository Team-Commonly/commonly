const AgentThreadService = require('../../../services/agentThreadService');

jest.mock('../../../models/Post', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
}));

const Post = require('../../../models/Post');
const AgentIdentityService = require('../../../services/agentIdentityService');

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
});
