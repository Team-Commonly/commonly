// F225 on real Post documents. What counts as an answer turns on the order and
// the ids of subdocuments, and on who wrote them, which a fake Post can't show.
process.env.PG_HOST = '';

jest.mock('../../services/agentMentionService', () => ({
  enqueueMentions: jest.fn(async () => ({ enqueued: [], implicit: [], woken: [] })),
}));

const mongoose = require('mongoose');

const model = (m) => m.default || m;
const User = model(require('../../models/User'));
const Pod = model(require('../../models/Pod'));
const Post = model(require('../../models/Post'));
const AgentIdentityService = model(require('../../services/agentIdentityService'));
const AgentThreadService = model(require('../../services/agentThreadService'));
const AgentMentionService = require('../../services/agentMentionService');
const postController = require('../../controllers/postController');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.setTimeout(60000);

let seq = 0;
const makeUser = (extra = {}) => {
  seq += 1;
  return User.create({
    username: `u${seq}${Date.now() % 1e5}`, email: `u${seq}${Date.now()}@x.com`, password: 'x'.repeat(12), ...extra,
  });
};

describe('comments on a real post', () => {
  let person;
  let agent;
  let otherAgent;
  let post;

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);

  beforeEach(async () => {
    person = await makeUser();
    agent = await makeUser({ isBot: true });
    otherAgent = await makeUser({ isBot: true });
    post = await Post.create({ userId: person._id, content: 'a post', comments: [] });
    jest.spyOn(AgentIdentityService, 'getOrCreateAgentUser').mockResolvedValue(agent);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await clearMongoDb();
  });

  test('the write itself refuses when the read saw no answer: a real Post, a stale copy', async () => {
    const asked = await addComment(person._id, '@seat a question');
    const stale = await Post.findById(post._id);
    await Post.updateOne(
      { _id: post._id },
      { $push: { comments: { userId: agent._id, text: 'the other turn', replyTo: asked } } },
    );
    const realFindById = Post.findById.bind(Post);
    jest.spyOn(Post, 'findById').mockImplementationOnce(async () => stale).mockImplementation(realFindById);

    const result = await postComment({ replyToCommentId: String(asked), onlyIfUnanswered: true });

    expect(result).toMatchObject({ success: true, duplicate: true, comment: { text: 'the other turn' } });
    expect((await Post.findById(post._id).lean()).comments.filter((c) => String(c.replyTo) === String(asked)))
      .toHaveLength(1);
  });

  test('two turns on one comment at once post one reply: a redelivered mention can reach here twice', async () => {
    const asked = new mongoose.Types.ObjectId();
    await Post.updateOne(
      { _id: post._id },
      { $push: { comments: { _id: asked, userId: person._id, text: 'a question' } } },
    );
    const reply = (text) => AgentThreadService.postComment({
      agentName: 'nova',
      threadId: String(post._id),
      content: text,
      replyToCommentId: String(asked),
      onlyIfUnanswered: true,
    });
    const results = await Promise.all([reply('first'), reply('second')]);
    const replies = (await Post.findById(post._id).lean()).comments
      .filter((comment) => String(comment.replyTo) === String(asked));
    expect(replies).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.every((result) => result.success && result.comment)).toBe(true);
    expect(results.map((result) => result.comment.text)).toEqual([replies[0].text, replies[0].text]);
  });

  const addComment = async (userId, text, replyTo = null) => {
    post.comments.push({ userId, text, replyTo });
    await post.save();
    return post.comments[post.comments.length - 1]._id;
  };
  const postComment = (extra) => AgentThreadService.postComment({
    agentName: 'seat', threadId: String(post._id), content: 'the answer', ...extra,
  });
  const storedComments = async () => (await Post.findById(post._id).lean()).comments;

  test('an unthreaded tool comment answering C3 does not swallow the reply to C4', async () => {
    await addComment(person._id, '@seat C3');
    const c4 = await addComment(person._id, '@seat C4');
    await postComment({ content: 'answering C3' });

    const result = await postComment({ replyToCommentId: String(c4), onlyIfUnanswered: true });

    expect(result.duplicate).toBeUndefined();
    expect((await storedComments()).at(-1)).toMatchObject({ text: 'the answer', replyTo: c4 });
  });

  test('a threaded reply to that exact comment is the answer', async () => {
    const c3 = await addComment(person._id, '@seat C3');
    await addComment(agent._id, 'answering C3', c3);
    const before = (await storedComments()).length;

    const result = await postComment({ replyToCommentId: String(c3), onlyIfUnanswered: true });

    expect(result).toMatchObject({ success: true, duplicate: true });
    expect(await storedComments()).toHaveLength(before);
  });

  test('a threaded reply to a different comment is not', async () => {
    const c3 = await addComment(person._id, '@seat C3');
    const c4 = await addComment(person._id, '@seat C4');
    await addComment(agent._id, 'answering C3', c3);

    const result = await postComment({ replyToCommentId: String(c4), onlyIfUnanswered: true });

    expect(result.duplicate).toBeUndefined();
  });

  // A seat that drops replyToCommentId would be handed its old comment, told
  // nothing new was posted, and end with NO_REPLY: the person gets nothing.
  test('a standalone tool comment posts when a person spoke after this agent\'s last one', async () => {
    await addComment(agent._id, 'my earlier take');
    await addComment(person._id, '@seat what do you mean?');

    const result = await postComment({});

    expect(result.duplicate).toBeUndefined();
    expect((await storedComments()).at(-1)).toMatchObject({ text: 'the answer' });
  });

  test('a person with no isBot field on their row still counts as a person', async () => {
    await User.collection.updateOne({ _id: person._id }, { $unset: { isBot: '' } });
    await addComment(agent._id, 'my earlier take');
    await addComment(person._id, '@seat what do you mean?');

    await expect(postComment({})).resolves.not.toHaveProperty('duplicate');
  });

  test('the one-standalone-comment rule holds when nobody spoke after it', async () => {
    await addComment(agent._id, 'my earlier take');

    const result = await postComment({});

    expect(result).toMatchObject({ success: true, duplicate: true });
    expect(await storedComments()).toHaveLength(1);
  });

  test('another agent speaking does not reopen it, so two curators cannot ping-pong', async () => {
    await addComment(agent._id, 'my earlier take');
    await addComment(otherAgent._id, 'a different angle');

    const result = await postComment({});

    expect(result).toMatchObject({ success: true, duplicate: true });
    expect(await storedComments()).toHaveLength(2);
  });

  test('a person speaking before this agent\'s comment does not reopen it', async () => {
    await addComment(person._id, 'first');
    await addComment(agent._id, 'my earlier take');

    await expect(postComment({})).resolves.toMatchObject({ duplicate: true });
  });
});

describe('addComment says which pod the post belongs to', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(async () => {
    jest.clearAllMocks();
    await clearMongoDb();
  });

  const commentOn = async (post, user) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await postController.addComment({
      params: { id: String(post._id) }, body: { text: '@seat look' }, userId: String(user._id), user,
    }, res);
    return AgentMentionService.enqueueMentions.mock.calls[0][0];
  };

  test('a pod post stamps its own pod', async () => {
    const user = await makeUser();
    const pod = await Pod.create({ name: 'p', type: 'chat', createdBy: user._id, members: [user._id] });
    const post = await Post.create({ userId: user._id, content: 'x', podId: pod._id, comments: [] });
    const mention = await commentOn(post, user);
    expect(String(mention.podId)).toBe(String(pod._id));
    expect(String(mention.message.thread.postPodId)).toBe(String(pod._id));
  });

  test('a post with no pod stamps none, though the mention still picks a pod', async () => {
    const user = await makeUser();
    const pod = await Pod.create({ name: 'p', type: 'chat', createdBy: user._id, members: [user._id] });
    const post = await Post.create({ userId: user._id, content: 'x', comments: [] });
    const mention = await commentOn(post, user);
    expect(String(mention.podId)).toBe(String(pod._id));
    expect(mention.message.thread.postPodId).toBeNull();
  });
});
