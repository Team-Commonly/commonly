const controller = require('../../../controllers/postController');
const Post = require('../../../models/Post');

jest.mock('../../../models/Post');

describe('postController', () => {
  afterEach(() => jest.clearAllMocks());

  it('getUserStats combines post and comment counts', async () => {
    Post.getPostCount.mockResolvedValue(5);
    Post.getCommentCount.mockResolvedValue(3);
    const req = { params: { userId: 'u1' } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await controller.getUserStats(req, res);
    expect(Post.getPostCount).toHaveBeenCalledWith('u1');
    expect(Post.getCommentCount).toHaveBeenCalledWith('u1');
    expect(res.json).toHaveBeenCalledWith({ postCount: 5, commentCount: 3 });
  });

  it('addComment returns 400 when text missing', async () => {
    const req = { params: { id: 'p1' }, body: {}, userId: 'u1' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.addComment(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('likePost toggles like state', async () => {
    const post = {
      _id: 'p1',
      userId: 'u1',
      likes: 0,
      likedBy: [],
      save: jest.fn(),
    };
    Post.findById.mockResolvedValue(post);
    const req = { params: { id: 'p1' }, userId: 'u1' };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await controller.likePost(req, res);
    expect(post.likes).toBe(1);
    expect(post.likedBy).toContain('u1');
  });

  it('likePost returns 404 for missing post', async () => {
    Post.findById.mockResolvedValue(null);
    const req = { params: { id: 'p1' }, userId: 'u1' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.likePost(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
