const request = require('supertest');
const express = require('express');

// Pod access on the post routes, keyed on the post's own pod.
//
// - Listing surfaces (the feed and search with no podId, followed threads)
//   show global posts plus the caller's own pods, via
//   DMService.listPodIdsForListing. Admins get NO bypass there.
// - Reads of one named pod or one post (feed/search with podId, follow) use
//   DMService.canViewPod, admin bypass included, as GET /api/posts/:id does.
// - Writes into a pod (comment, like/unlike) use the pod write gate
//   (membership).
// - Unfollow is never refused for pod access: you may always drop your own
//   follow.
// - Global posts (no pod) are open to any signed-in user throughout.
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
  let adminPodPost;

  const as = (user) => ({ 'x-test-user': String(user._id) });
  const ids = (body) => body.map((p) => String(p._id)).sort();
  const idsOf = (...posts) => posts.map((p) => String(p._id)).sort();

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
    const adminPod = await mkPod('Admin own', admin);

    podPost = await mkPost(member, 'needle in the private pod', pod._id);
    globalPost = await mkPost(member, 'needle in the global feed', null);
    outsiderPodPost = await mkPost(outsider, 'needle in the outsider pod', outsiderPod._id);
    adminPodPost = await mkPost(admin, 'needle in the admin pod', adminPod._id);
  });

  describe('GET /api/posts (the feed)', () => {
    it('shows a member their pod\'s posts alongside global posts', async () => {
      const res = await request(app).get('/api/posts').set(as(member)).expect(200);
      expect(ids(res.body.posts)).toEqual(idsOf(podPost, globalPost));
      expect(res.body.total).toBe(2);
    });

    it('leaves out pods a non-member is not in, keeping global posts and their own pods', async () => {
      const res = await request(app).get('/api/posts').set(as(outsider)).expect(200);
      expect(ids(res.body.posts)).toEqual(idsOf(globalPost, outsiderPodPost));
      expect(res.body.total).toBe(2);
    });

    it('scopes the hot sort the same way', async () => {
      const res = await request(app).get('/api/posts?sort=hot').set(as(outsider)).expect(200);
      expect(ids(res.body.posts)).toEqual(idsOf(globalPost, outsiderPodPost));
    });

    it('returns a named pod\'s posts on the hot sort too', async () => {
      const res = await request(app).get(`/api/posts?sort=hot&podId=${pod._id}`).set(as(member)).expect(200);
      expect(ids(res.body.posts)).toEqual(idsOf(podPost));
    });

    it('gives an admin no bypass: their own pods and global posts only', async () => {
      const res = await request(app).get('/api/posts').set(as(admin)).expect(200);
      expect(ids(res.body.posts)).toEqual(idsOf(globalPost, adminPodPost));
    });

    it('still lets an admin read a pod they name, through canViewPod', async () => {
      const res = await request(app).get(`/api/posts?podId=${pod._id}`).set(as(admin)).expect(200);
      expect(ids(res.body.posts)).toEqual(idsOf(podPost));
    });

    it('refuses a non-member who names the pod, with 403', async () => {
      await request(app).get(`/api/posts?podId=${pod._id}`).set(as(outsider)).expect(403);
    });

    it('keeps podId=global to global posts only', async () => {
      const res = await request(app).get('/api/posts?podId=global').set(as(outsider)).expect(200);
      expect(ids(res.body.posts)).toEqual(idsOf(globalPost));
    });
  });

  describe('GET /api/posts/search', () => {
    it('returns a member the pod post alongside global posts', async () => {
      const res = await request(app).get('/api/posts/search?query=needle').set(as(member)).expect(200);
      expect(ids(res.body)).toEqual(idsOf(podPost, globalPost));
    });

    it('leaves out pods a non-member is not in, keeping global posts and their own pods', async () => {
      const res = await request(app).get('/api/posts/search?query=needle').set(as(outsider)).expect(200);
      expect(ids(res.body)).toEqual(idsOf(globalPost, outsiderPodPost));
    });

    it('also filters a match that is only in a comment', async () => {
      podPost.comments.push({ userId: member._id, text: 'haystack-only-word', createdAt: new Date() });
      await podPost.save();
      const res = await request(app).get('/api/posts/search?query=haystack-only-word')
        .set(as(outsider)).expect(200);
      expect(res.body).toEqual([]);
    });

    it('gives an admin no bypass: their own pods and global posts only', async () => {
      const res = await request(app).get('/api/posts/search?query=needle').set(as(admin)).expect(200);
      expect(ids(res.body)).toEqual(idsOf(globalPost, adminPodPost));
    });

    it('refuses a non-member who names the pod, with 403', async () => {
      const res = await request(app).get(`/api/posts/search?query=needle&podId=${pod._id}`)
        .set(as(outsider)).expect(403);
      expect(res.body).toEqual({ error: 'Not authorized to view posts in this pod' });
    });

    it('lets a member search inside the pod', async () => {
      const res = await request(app).get(`/api/posts/search?query=needle&podId=${pod._id}`)
        .set(as(member)).expect(200);
      expect(ids(res.body)).toEqual(idsOf(podPost));
    });

    it('still lets an admin search a pod they name, through canViewPod', async () => {
      const res = await request(app).get(`/api/posts/search?query=needle&podId=${pod._id}`)
        .set(as(admin)).expect(200);
      expect(ids(res.body)).toEqual(idsOf(podPost));
    });

    it('answers 404 for a pod that does not exist', async () => {
      await request(app).get(`/api/posts/search?podId=${outsider._id}`).set(as(outsider)).expect(404);
    });

    it('keeps podId=global to global posts only', async () => {
      const res = await request(app).get('/api/posts/search?query=needle&podId=global').set(as(outsider)).expect(200);
      expect(ids(res.body)).toEqual(idsOf(globalPost));
    });
  });

  describe('GET /api/posts/following/threads', () => {
    const follow = (user, ...posts) => User.updateOne({ _id: user._id }, {
      followedThreads: posts.map((p) => ({ postId: p._id })),
    });

    it('lists a member\'s followed pod thread', async () => {
      await follow(member, podPost, globalPost);
      const res = await request(app).get('/api/posts/following/threads').set(as(member)).expect(200);
      expect(ids(res.body.threads)).toEqual(idsOf(podPost, globalPost));
    });

    it('drops a followed thread whose pod the caller is no longer in, and keeps global ones', async () => {
      // As if followed while a member, before leaving the pod.
      await follow(outsider, podPost, globalPost);
      const res = await request(app).get('/api/posts/following/threads').set(as(outsider)).expect(200);
      expect(ids(res.body.threads)).toEqual(idsOf(globalPost));
    });

    it('gives an admin no bypass: a followed thread outside their pods drops out', async () => {
      await follow(admin, podPost, globalPost, adminPodPost);
      const res = await request(app).get('/api/posts/following/threads').set(as(admin)).expect(200);
      expect(ids(res.body.threads)).toEqual(idsOf(globalPost, adminPodPost));
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

    it('lets a user who is no longer in the pod remove their own follow', async () => {
      await User.updateOne({ _id: outsider._id }, {
        followedThreads: [{ postId: podPost._id }, { postId: globalPost._id }],
      });
      await request(app).delete(`/api/posts/${podPost._id}/follow`).set(as(outsider)).expect(200);
      const stored = await User.findById(outsider._id).select('followedThreads').lean();
      expect(stored.followedThreads.map((t) => String(t.postId))).toEqual([String(globalPost._id)]);
    });

    it('lets anyone signed in unfollow a global post', async () => {
      await request(app).delete(`/api/posts/${globalPost._id}/follow`).set(as(outsider)).expect(200);
    });
  });

  describe('POST /api/posts/:id/like', () => {
    const likesOf = async (post) => {
      const stored = await Post.findById(post._id).select('likes likedBy').lean();
      return { likes: stored.likes, likedBy: stored.likedBy.map(String) };
    };

    it('lets a member like and unlike a pod post', async () => {
      const liked = await request(app).post(`/api/posts/${podPost._id}/like`).set(as(member)).expect(200);
      expect(liked.body).toEqual({ likes: 1, liked: true });
      expect(await likesOf(podPost)).toEqual({ likes: 1, likedBy: [String(member._id)] });
      const unliked = await request(app).post(`/api/posts/${podPost._id}/like`).set(as(member)).expect(200);
      expect(unliked.body).toEqual({ likes: 0, liked: false });
    });

    it('refuses a non-member\'s like with 403 and leaves the count alone', async () => {
      const res = await request(app).post(`/api/posts/${podPost._id}/like`).set(as(outsider)).expect(403);
      expect(res.body).toEqual({ error: 'You are not a member of this pod' });
      expect(await likesOf(podPost)).toEqual({ likes: 0, likedBy: [] });
    });

    it('refuses a non-member\'s unlike with 403 and leaves their old like in place', async () => {
      // As if liked while a member, before leaving the pod.
      await Post.updateOne({ _id: podPost._id }, { likes: 1, likedBy: [outsider._id] });
      await request(app).post(`/api/posts/${podPost._id}/like`).set(as(outsider)).expect(403);
      expect(await likesOf(podPost)).toEqual({ likes: 1, likedBy: [String(outsider._id)] });
    });

    it('lets anyone signed in like a global post', async () => {
      const res = await request(app).post(`/api/posts/${globalPost._id}/like`).set(as(outsider)).expect(200);
      expect(res.body).toEqual({ likes: 1, liked: true });
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
