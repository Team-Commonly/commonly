const mongoose = require('mongoose');
const User = require('../../../models/User');
const Post = require('../../../models/Post');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('Post Model Tests', () => {
  let user;

  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    user = new User({ username: 'user', email: 'user@example.com', password: 'Pass123!' });
    await user.save();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('counts posts and comments for a user', async () => {
    const p1 = new Post({ userId: user._id, content: 'one', comments: [{ userId: user._id, text: 'c' }] });
    const p2 = new Post({ userId: user._id, content: 'two' });
    await p1.save();
    await p2.save();

    const postCount = await Post.getPostCount(user._id);
    const commentCount = await Post.getCommentCount(user._id);
    expect(postCount).toBe(2);
    expect(commentCount).toBe(1);
  });
});
