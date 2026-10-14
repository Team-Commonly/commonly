const request = require('supertest');
const express = require('express');

// Pod access on the post routes that take a post id or search across posts:
// search, followed threads, follow/unfollow and comments. Reads (search,
// followed threads, follow) use DMService.canViewPod on the post's own pod, the
// gate GET /api/posts/:id and GET /api/posts?podId= already use. Writing a
// comment uses the pod write gate (membership). Global posts (no pod) stay
// open to any signed-in user.
//
// Real routes, controller, models and access services on memory Mongo; only
// the JWT check and the agent-mention fan-out are stubbed.

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ msg: 'No token, authorization denied' });
  req.user = { id };
  req.userId = id;
  return next();
});
jest.mock('../../../models/pg/Pod', () => null);

const mockEnqueueMentions = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/agentMentionService', () => ({
  enqueueMentions: (...args) => mockEnqueueMentions(...args),
}));

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const Post = require('../../../models/Post');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const Activity = require('../../../models/Activity');
const routes = require('../../../routes/posts');

describe('post routes check the post\'s pod', () => {
  let app;
  let member;
  let outsider;
  let admin;
  let pod;
  let memberOtherPod;
  let outsiderPod;
  let podPost;
  let globalPost;
  let outsiderPodPost;

  const as = (user) => ({ 'x-test-user': String(user._id) });
  const ids = (body) => body.map((p) => String(p._id)).sort();

  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    mockEnqueueMentions.mockClear();
    app = express();
    app.use(express.json());
    app.use('/api/posts', routes);

    const mkUser = (name, extra = {}) => User.create({
      username: name, email: `${name}@example.com`, password: 'placeholder', ...extra,
    });
    const mkPod = (name, owner) => Pod.create({
      name, type: 'chat', createdBy: owner._id, members: [owner._id],
    });
    const mkPost = (author, content, podId) => Post.create({ userId: author._id, content, podId });

    member = await mkUser('member');
    outsider = await mkUser('outsider');
    admin = await mkUser('admin', { role: 'admin' });

    pod = await mkPod('Private', member);
    memberOtherPod = await mkPod('Member other', member);
    outsiderPod = await mkPod('Outsider own', outsider);

    podPost = await mkPost(member, 'needle in the private pod', pod._id);
    globalPost = await mkPost(member, 'needle in the global feed', null);
    outsiderPodPost = await mkPost(outsider, 'needle in the outsider pod', outsiderPod._id);
  });

  describe('GET /api/posts/search', () => {
    it('returns a member the pod post alongside global posts', async () => {
      const res = await request(app).get('/api/posts/search?query=needle').set(as(member)).expect(200);
      expect(ids(res.body)).toEqual([String(podPost._id), String(globalPost._id)].sort());
    });

    it('leaves out a private pod a non-member is not in, keeping global posts and their own pods', async () => {
      const res = await request(app).get('/api/posts/search?query=needle').set(as(outsider)).expect(200);
      expect(ids(res.body)).toEqual([String(globalPost._id), String(outsiderPodPost._id)].sort());
    });

    it('also filters a match that is only in a comment', async () => {
      podPost.comments.push({ userId: member._id, text: 'haystack-only-word', createdAt: new Date() });
      await podPost.save();
      const res = await request(app).get('/api/posts/search?query=haystack-only-word')
        .set(as(outsider)).expect(200);
      expect(res.body).toEqual([]);
    });

    it('refuses a non-member who names the pod, with 403', async () => {
      const res = await request(app).get(`/api/posts/search?query=needle&podId=${pod._id}`)
        .set(as(outsider)).expect(403);
      expect(res.body).toEqual({ error: 'Not authorized to view posts in this pod' });
    });

    it('lets a member search inside the pod', async () => {
      const res = await request(app).get(`/api/posts/search?query=needle&podId=${pod._id}`).set(as(member)).expect(200);
      expect(ids(res.body)).toEqual([String(podPost._id)]);
    });

    it('answers 404 for a pod that does not exist', async () => {
      await request(app).get(`/api/posts/search?podId=${outsider._id}`).set(as(outsider)).expect(404);
    });

    it('keeps podId=global to global posts only', async () => {
      const res = await request(app).get('/api/posts/search?query=needle&podId=global').set(as(outsider)).expect(200);
      expect(ids(res.body)).toEqual([String(globalPost._id)]);
    });

    it('gives a global admin every pod, as canViewPod does', async () => {
      const res = await request(app).get('/api/posts/search?query=needle').set(as(admin)).expect(200);
      expect(ids(res.body)).toEqual([String(podPost._id), String(globalPost._id), String(outsiderPodPost._id)].sort());
    });
  });

  describe('GET /api/posts/following/threads', () => {
    it('lists a member\'s followed pod thread', async () => {
      await User.updateOne({ _id: member._id }, {
        followedThreads: [{ postId: podPost._id }, { postId: globalPost._id }],
      });
      const res = await request(app).get('/api/posts/following/threads').set(as(member)).expect(200);
      expect(ids(res.body.threads)).toEqual([String(podPost._id), String(globalPost._id)].sort());
    });

    it('drops a followed thread whose pod the caller can no longer view, and keeps global ones', async () => {
      // As if followed while a member, before leaving the pod.
      await User.updateOne({ _id: outsider._id }, {
        followedThreads: [{ postId: podPost._id }, { postId: globalPost._id }],
      });
      const res = await request(app).get('/api/posts/following/threads').set(as(outsider)).expect(200);
      expect(ids(res.body.threads)).toEqual([String(globalPost._id)]);
    });
  });

  describe('POST /api/posts/:id/follow', () => {
    it('lets a member follow a pod post', async () => {
      const res = await request(app).post(`/api/posts/${podPost._id}/follow`).set(as(member)).expect(200);
      expect(res.body).toMatchObject({ success: true, followed: true, postId: String(podPost._id) });
      const stored = await User.findById(member._id).select('followedThreads').lean();
      expect(stored.followedThreads.map((t) => String(t.postId))).toEqual([String(podPost._id)]);
      // Positive control for the refusal case's zero-activity assertion.
      expect(await Activity.countDocuments({ action: 'thread_followed' })).toBe(1);
    });

    it('refuses a non-member with 403 and records nothing', async () => {
      const res = await request(app).post(`/api/posts/${podPost._id}/follow`).set(as(outsider)).expect(403);
      expect(res.body).toEqual({ error: 'Not authorized to view this post' });
      const stored = await User.findById(outsider._id).select('followedThreads').lean();
      expect(stored.followedThreads).toEqual([]);
      expect(await Activity.countDocuments({ action: 'thread_followed' })).toBe(0);
    });

    it('lets anyone signed in follow a global post', async () => {
      await request(app).post(`/api/posts/${globalPost._id}/follow`).set(as(outsider)).expect(200);
    });
  });

  describe('DELETE /api/posts/:id/follow', () => {
    it('lets a member unfollow a pod post', async () => {
      await User.updateOne({ _id: member._id }, { followedThreads: [{ postId: podPost._id }] });
      await request(app).delete(`/api/posts/${podPost._id}/follow`).set(as(member)).expect(200);
      const stored = await User.findById(member._id).select('followedThreads').lean();
      expect(stored.followedThreads).toEqual([]);
    });

    it('refuses a non-member with 403 and leaves their list untouched', async () => {
      await User.updateOne({ _id: outsider._id }, { followedThreads: [{ postId: podPost._id }] });
      const res = await request(app).delete(`/api/posts/${podPost._id}/follow`).set(as(outsider)).expect(403);
      expect(res.body).toEqual({ error: 'Not authorized to view this post' });
      const stored = await User.findById(outsider._id).select('followedThreads').lean();
      expect(stored.followedThreads.map((t) => String(t.postId))).toEqual([String(podPost._id)]);
    });

    it('lets anyone signed in unfollow a global post', async () => {
      await request(app).delete(`/api/posts/${globalPost._id}/follow`).set(as(outsider)).expect(200);
    });
  });

  describe('POST /api/posts/:id/comments', () => {
    it('lets a member comment on a pod post, filing mention and activity under the post\'s pod', async () => {
      // A request-body podId naming another of the member's pods is ignored.
      const res = await request(app)
        .post(`/api/posts/${podPost._id}/comments`)
        .set(as(member))
        .send({ text: 'hello', podId: String(memberOtherPod._id) })
        .expect(201);
      expect(res.body.text).toBe('hello');

      expect(mockEnqueueMentions).toHaveBeenCalledTimes(1);
      expect(String(mockEnqueueMentions.mock.calls[0][0].podId)).toBe(String(pod._id));
      const activity = await Activity.findOne({ action: 'thread_comment' }).lean();
      expect(String(activity.podId)).toBe(String(pod._id));
    });

    it('refuses a non-member with 403 and writes no comment, mention or activity', async () => {
      const res = await request(app)
        .post(`/api/posts/${podPost._id}/comments`)
        .set(as(outsider))
        .send({ text: 'let me in' })
        .expect(403);
      expect(res.body).toEqual({ error: 'You are not a member of this pod' });

      const stored = await Post.findById(podPost._id).lean();
      expect(stored.comments).toHaveLength(0);
      expect(mockEnqueueMentions).not.toHaveBeenCalled();
      expect(await Activity.countDocuments({ action: 'thread_comment' })).toBe(0);
    });

    it('keeps global posts open, and never files the activity under a pod named in the body', async () => {
      await request(app)
        .post(`/api/posts/${globalPost._id}/comments`)
        .set(as(outsider))
        .send({ text: 'global reply', podId: String(pod._id) })
        .expect(201);

      const stored = await Post.findById(globalPost._id).lean();
      expect(stored.comments.map((c) => c.text)).toEqual(['global reply']);
      const activity = await Activity.findOne({ action: 'thread_comment' }).lean();
      expect(activity.podId).toBeUndefined();
      // A global post's mention still falls back to a pod the commenter is in.
      expect(String(mockEnqueueMentions.mock.calls[0][0].podId)).toBe(String(outsiderPod._id));
    });
  });
});
