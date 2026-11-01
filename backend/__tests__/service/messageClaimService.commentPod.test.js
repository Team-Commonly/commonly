// A post-thread comment is claimed in the pod its post lives in, checked
// against real Post documents rather than a mocked filter: the query has to
// reach `comments._id` and cast the pod id the way Mongo stores it.
process.env.PG_HOST = '';

const mongoose = require('mongoose');
const Post = require('../../models/Post');
const MessageClaimService = require('../../services/messageClaimService');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');

const id = () => new mongoose.Types.ObjectId();

describe('claiming a post-thread comment', () => {
  const podA = id();
  const podB = id();
  let podComment;
  let globalComment;

  beforeAll(async () => {
    await setupMongoDb();
  });

  beforeEach(async () => {
    const author = id();
    const inPod = await Post.create({
      podId: podA, userId: author, content: 'in pod A', comments: [{ userId: author, text: '@seat look' }],
    });
    const global = await Post.create({
      podId: null, userId: author, content: 'global', comments: [{ userId: author, text: '@seat look' }],
    });
    podComment = String(inPod.comments[0]._id);
    globalComment = String(global.comments[0]._id);
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  test('is accepted in its own pod and refused in another', async () => {
    await expect(MessageClaimService.messageExists(podComment, String(podA))).resolves.toBe(true);
    await expect(MessageClaimService.messageExists(podComment, String(podB))).resolves.toBe(false);
  });

  test('on a global post, is accepted in the pod its mention was delivered to', async () => {
    // postController delivers it to the commenter's first pod, which the
    // comment does not record, so any pod the route authorized is accepted.
    await expect(MessageClaimService.messageExists(globalComment, String(podB))).resolves.toBe(true);
  });

  test('that does not exist is refused in every pod', async () => {
    await expect(MessageClaimService.messageExists(String(id()), String(podA))).resolves.toBe(false);
  });
});
