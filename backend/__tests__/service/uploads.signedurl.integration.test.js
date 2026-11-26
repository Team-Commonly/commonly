/**
 * ADR-002 Phase 1b-a — signed-URL end-to-end smoke.
 *
 * Unit tests mock Mongo queries and the PG pool, so they can't catch
 * regressions that depend on real Mongoose regex semantics, real ObjectId
 * coercion, or the rate-limiter's interaction with middleware ordering.
 * This suite exercises the mint endpoint end-to-end against a real
 * MongoMemoryServer (for User/Post/Pod/File/AuditLog) and a mocked PG pool
 * that simulates the multi-pod fan-out path.
 *
 * Coverage targets:
 *   - Owner path (canReadAttachment short-circuit on File.uploadedBy)
 *   - Public post reference → any authed viewer can mint
 *   - Pod-scoped post, viewer NOT in pod → 403
 *   - Profile picture stored as an absolute URL (fix #4 regression — real
 *     Mongoose substring regex against an absolute URL document)
 *   - PG fan-out: messages reference the file in multiple pods, viewer is a
 *     member of one → mint succeeds (fix #3 regression)
 *   - Rate limiter: 31st mint within the window → 429 (fix #1 regression —
 *     rate limiter keyed on userId, which requires auth to run first)
 *   - Audit log row is written on successful mint
 */

const express = require('express');
const request = require('supertest');
const { createHash } = require('crypto');

const { setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken } = require('../utils/testUtils');

// Mock db-pg before requiring routes. `attachmentAccess` reads this via
// `require('../config/db-pg')` inside `findMessagePodsReferencingFile`, so
// the mock intercepts it without needing pg-mem or a real Postgres.
const mockPgPool = { query: jest.fn() };
jest.mock('../../config/db-pg', () => ({ pool: mockPgPool }));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Post = require('../../models/Post');
const File = require('../../models/File');
const AuditLog = require('../../models/AuditLog');
const { AgentInstallation } = require('../../models/AgentRegistry');

const uploadsRoutes = require('../../routes/uploads');

describe('ADR-002 Phase 1b-a — signed-URL mint (integration)', () => {
  let app;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-adr002-integration';
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/uploads', uploadsRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    mockPgPool.query.mockReset();
    mockPgPool.query.mockResolvedValue({ rows: [] });
  });

  async function makeUser(override = {}) {
    return User.create({
      username: `u-${Math.random().toString(36).slice(2, 10)}`,
      email: `${Math.random().toString(36).slice(2, 10)}@test.com`,
      password: 'Password123!',
      ...override,
    });
  }

  it('mints a signed URL for the uploader', async () => {
    const owner = await makeUser();
    const token = generateTestToken(owner._id);
    await File.create({
      fileName: 'owned.png',
      originalName: 'owned.png',
      contentType: 'image/png',
      size: 10,
      uploadedBy: owner._id,
    });

    const res = await request(app)
      .get('/api/uploads/owned.png/url')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.url).toMatch(/^\/api\/uploads\/owned\.png\?t=/);
    expect(res.body.expiresIn).toBe(300);
  });

  it('mints for any authed viewer when the file is referenced in a public post', async () => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const viewerToken = generateTestToken(viewer._id);
    await File.create({
      fileName: 'in-public-post.png',
      originalName: 'x.png',
      contentType: 'image/png',
      size: 10,
      uploadedBy: owner._id,
    });
    await Post.create({
      userId: owner._id,
      content: 'check out /api/uploads/in-public-post.png',
      image: '/api/uploads/in-public-post.png',
    });

    await request(app)
      .get('/api/uploads/in-public-post.png/url')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
  });

  it('denies the mint when viewer is not a member of the only referencing pod', async () => {
    const owner = await makeUser();
    const outsider = await makeUser();
    const outsiderToken = generateTestToken(outsider._id);
    const pod = await Pod.create({
      name: 'private',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id],
    });
    await File.create({
      fileName: 'in-private-pod.png',
      originalName: 'x.png',
      contentType: 'image/png',
      size: 10,
      uploadedBy: owner._id,
    });
    await Post.create({
      userId: owner._id,
      podId: pod._id,
      content: 'see /api/uploads/in-private-pod.png',
      image: '/api/uploads/in-private-pod.png',
    });

    await request(app)
      .get('/api/uploads/in-private-pod.png/url')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .expect(403);
  });

  it('authorizes a runtime-token agent who belongs to the file pod before the object lookup', async () => {
    const owner = await makeUser();
    const agentToken = 'cm_agent_attachment-read-integration';
    const agent = await makeUser({
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'attachment-reader', instanceId: 'default' },
      agentRuntimeTokens: [{
        tokenHash: createHash('sha256').update(agentToken).digest('hex'),
        label: 'attachment-read-integration',
        createdAt: new Date(),
      }],
    });
    const pod = await Pod.create({
      name: 'agent-readable attachment pod',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id, agent._id],
    });
    await AgentInstallation.create({
      agentName: 'attachment-reader', instanceId: 'default', podId: pod._id,
      version: '1.0.0', installedBy: owner._id,
    });
    await File.create({
      fileName: 'agent-readable.png',
      originalName: 'agent-readable.png',
      contentType: 'image/png',
      size: 10,
      uploadedBy: owner._id,
      podId: pod._id,
    });

    // No object bytes are seeded, so a 404 proves authorization succeeded
    // and the request reached the storage lookup. A failed agent ACL would
    // stop earlier with 403.
    await request(app)
      .get('/api/uploads/agent-readable.png')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(404);
  });

  it('serves a POD-SCOPED file to a Bearer member, and refuses a bot row on the same path (TASK-133)', async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const memberToken = generateTestToken(member._id);
    const agent = await makeUser({
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'file-reader', instanceId: 'default' },
    });
    const agentToken = generateTestToken(agent._id);
    const pod = await Pod.create({
      name: 'member-and-agent attachment pod',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id, member._id, agent._id],
    });
    await File.create({
      fileName: 'member-readable.png',
      originalName: 'member-readable.png',
      contentType: 'image/png',
      size: 10,
      uploadedBy: owner._id,
      podId: pod._id,
    });

    // The member's row is live and the ACL allows: no object bytes are seeded,
    // so 404 proves authorization succeeded and the request reached the storage
    // lookup. This is the read TASK-133 must not break, against a real row.
    await request(app)
      .get('/api/uploads/member-readable.png')
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(404);

    // Same pod, same ACL answer, an agent row: refused by the live-row read
    // before the ACL is consulted. Both halves run on real Mongo rows, so the
    // members' read is not a mock agreeing with itself.
    await request(app)
      .get('/api/uploads/member-readable.png')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);
  });

  it('403s a Bearer whose id is not a usable account id at all, rather than 500ing', async () => {
    const owner = await makeUser();
    const pod = await Pod.create({
      name: 'cast-error attachment pod',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id],
    });
    await File.create({
      fileName: 'cast-error.png',
      originalName: 'cast-error.png',
      contentType: 'image/png',
      size: 10,
      uploadedBy: owner._id,
      podId: pod._id,
    });

    // The live-row read casts the id, so a signature-valid token carrying a
    // non-ObjectId id throws a CastError. The route's catch must turn that into
    // a refusal: this is the mechanism that took the unit suite red on CI, where
    // the auth stub writes the literal string 'member-1' as `req.userId`.
    await request(app)
      .get('/api/uploads/cast-error.png')
      .set('Authorization', `Bearer ${generateTestToken('member-1')}`)
      .expect(403);
  });

  it('matches a profile picture stored as an absolute URL (fix #4 — real substring regex)', async () => {
    const subject = await makeUser({
      profilePicture: 'https://api-dev.commonly.me/api/uploads/avatar.png',
    });
    const viewer = await makeUser();
    const viewerToken = generateTestToken(viewer._id);
    await File.create({
      fileName: 'avatar.png',
      originalName: 'avatar.png',
      contentType: 'image/png',
      size: 10,
      uploadedBy: subject._id,
    });

    await request(app)
      .get('/api/uploads/avatar.png/url')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
  });

  describe('a profile picture grants reads only for an avatar its holder could publish', () => {
    // A pod-scoped file A uploaded into a private pod, plus a non-member B.
    async function seedPodFile({ fileName, formerMember = false } = {}) {
      const owner = await makeUser();
      const other = await makeUser();
      const pod = await Pod.create({
        name: 'private',
        type: 'chat',
        createdBy: owner._id,
        members: formerMember ? [owner._id, other._id] : [owner._id],
      });
      await File.create({
        fileName,
        originalName: fileName,
        contentType: 'image/png',
        size: 10,
        uploadedBy: owner._id,
        podId: pod._id,
      });
      return { owner, other, pod };
    }

    async function expectRefused(user, fileName) {
      const token = generateTestToken(user._id);
      await request(app)
        .get(`/api/uploads/${fileName}/url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app)
        .get(`/api/uploads/${fileName}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    }

    it('(a) refuses a non-member who points their own profilePicture at a pod file', async () => {
      const fileName = 'user-a-1-pod.png';
      const { other } = await seedPodFile({ fileName });
      await User.updateOne({ _id: other._id }, { $set: { profilePicture: `/api/uploads/${fileName}` } });

      await expectRefused(other, fileName);
    });

    it('(d) refuses a removed member who re-references a pod file through their profilePicture', async () => {
      const fileName = 'user-a-2-pod.png';
      const { other, pod } = await seedPodFile({ fileName, formerMember: true });
      // While a member, the read is granted by pod scope.
      await request(app)
        .get(`/api/uploads/${fileName}/url`)
        .set('Authorization', `Bearer ${generateTestToken(other._id)}`)
        .expect(200);

      await Pod.updateOne({ _id: pod._id }, { $pull: { members: other._id } });
      await User.updateOne(
        { _id: other._id },
        { $set: { profilePicture: `https://api.example.test/api/uploads/${fileName}` } },
      );

      await expectRefused(other, fileName);
    });

    it('(b) still lets any signed-in viewer read a real avatar its holder uploaded', async () => {
      const subject = await makeUser();
      const viewer = await makeUser();
      const viewerToken = generateTestToken(viewer._id);
      const fileName = 'user-s-1-avatar.png';
      await File.create({
        fileName, originalName: 'avatar.png', contentType: 'image/png', size: 10, uploadedBy: subject._id,
      });
      await User.updateOne({ _id: subject._id }, { $set: { profilePicture: `/api/uploads/${fileName}` } });

      const res = await request(app)
        .get(`/api/uploads/${fileName}/url`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);
      // No object bytes are seeded, so 404 means the read was authorized.
      await request(app).get(res.body.url).expect(404);
    });

    it('(c) lets a holder publish their own pod upload as an avatar to non-members', async () => {
      const fileName = 'user-a-3-pod.png';
      const { owner } = await seedPodFile({ fileName });
      await User.updateOne({ _id: owner._id }, { $set: { profilePicture: `/api/uploads/${fileName}` } });
      const viewer = await makeUser();

      await request(app)
        .get(`/api/uploads/${fileName}/url`)
        .set('Authorization', `Bearer ${generateTestToken(owner._id)}`)
        .expect(200);
      await request(app)
        .get(`/api/uploads/${fileName}/url`)
        .set('Authorization', `Bearer ${generateTestToken(viewer._id)}`)
        .expect(200);
    });

    it('refuses when only non-uploaders reference a pod file, however many of them', async () => {
      const fileName = 'user-a-4-pod.png';
      const { other } = await seedPodFile({ fileName });
      const third = await makeUser({ profilePicture: `/api/uploads/${fileName}` });
      await User.updateOne({ _id: other._id }, { $set: { profilePicture: `/api/uploads/${fileName}` } });

      await expectRefused(other, fileName);
      await expectRefused(third, fileName);
    });
  });

  describe("a post or message reference grants a pod file only while its author can read the file", () => {
    // File F lives in private pod P (uploaded by `owner`). `author` writes the
    // reference; `viewer` is outside P and tries to read F through it.
    async function seed({ fileName, authorInPod = false } = {}) {
      const owner = await makeUser();
      const author = await makeUser();
      const viewer = await makeUser();
      const pod = await Pod.create({
        name: 'private',
        type: 'chat',
        createdBy: owner._id,
        members: authorInPod ? [owner._id, author._id] : [owner._id],
      });
      await File.create({
        fileName, originalName: fileName, contentType: 'image/png', size: 10,
        uploadedBy: owner._id, podId: pod._id,
      });
      return { owner, author, viewer, pod };
    }

    const mint = (user, fileName) => request(app)
      .get(`/api/uploads/${fileName}/url`)
      .set('Authorization', `Bearer ${generateTestToken(user._id)}`);
    const directRead = (user, fileName) => request(app)
      .get(`/api/uploads/${fileName}`)
      .set('Authorization', `Bearer ${generateTestToken(user._id)}`);

    it("does not grant through a non-member's public post", async () => {
      const fileName = 'user-o-10-pod.png';
      const { author, viewer } = await seed({ fileName });
      await Post.create({ userId: author._id, content: `look /api/uploads/${fileName}` });

      await mint(viewer, fileName).expect(403);
      await directRead(viewer, fileName).expect(403);
      await mint(author, fileName).expect(403);
    });

    it("does not grant through a non-member's post in a pod they belong to", async () => {
      const fileName = 'user-o-11-pod.png';
      const { author } = await seed({ fileName });
      const own = await Pod.create({ name: 'own', type: 'chat', createdBy: author._id, members: [author._id] });
      await Post.create({ userId: author._id, podId: own._id, content: 'mine', image: `/api/uploads/${fileName}` });

      await mint(author, fileName).expect(403);
      await directRead(author, fileName).expect(403);
    });

    it("stops granting through a removed member's public post once they leave", async () => {
      const fileName = 'user-o-12-pod.png';
      const { author, viewer, pod } = await seed({ fileName, authorInPod: true });
      await Post.create({ userId: author._id, content: `see /api/uploads/${fileName}` });
      await mint(viewer, fileName).expect(200);

      await Pod.updateOne({ _id: pod._id }, { $pull: { members: author._id } });

      await mint(viewer, fileName).expect(403);
      await mint(author, fileName).expect(403);
      await directRead(author, fileName).expect(403);
    });

    it("stops granting through a removed member's PG message once they leave", async () => {
      const fileName = 'user-o-13-pod.png';
      const { author, pod } = await seed({ fileName, authorInPod: true });
      const own = await Pod.create({ name: 'own', type: 'chat', createdBy: author._id, members: [author._id] });
      // The reference query carries the author rule as `user_id = ANY($2)`
      // (F610); the mock answers it the way Postgres would.
      const row = { pod_id: own._id.toString(), user_id: author._id.toString() };
      mockPgPool.query.mockImplementation(async (sql, params) => ({
        rows: /ANY\(\$2/.test(sql) && !params[1].includes(row.user_id) ? [] : [row],
      }));
      await Pod.updateOne({ _id: pod._id }, { $pull: { members: author._id } });

      await mint(author, fileName).expect(403);
      await directRead(author, fileName).expect(403);
    });

    it("keeps a current member's forward into another pod readable there", async () => {
      const fileName = 'user-o-14-pod.png';
      const { author, viewer } = await seed({ fileName, authorInPod: true });
      const other = await Pod.create({
        name: 'other', type: 'chat', createdBy: author._id, members: [author._id, viewer._id],
      });
      await Post.create({ userId: author._id, podId: other._id, content: 'fwd', image: `/api/uploads/${fileName}` });

      await mint(viewer, fileName).expect(200);
      await directRead(viewer, fileName).expect(404); // authorized; no bytes seeded
    });

    it("keeps a current member's PG message forward readable in that pod", async () => {
      const fileName = 'user-o-15-pod.png';
      const { author, viewer } = await seed({ fileName, authorInPod: true });
      const other = await Pod.create({
        name: 'other', type: 'chat', createdBy: author._id, members: [author._id, viewer._id],
      });
      mockPgPool.query.mockResolvedValue({
        rows: [{ pod_id: other._id.toString(), user_id: author._id.toString() }],
      });

      await mint(viewer, fileName).expect(200);
    });

    it("keeps a current member's public post readable by anyone signed in", async () => {
      const fileName = 'user-o-16-pod.png';
      const { author, viewer } = await seed({ fileName, authorInPod: true });
      await Post.create({ userId: author._id, content: `public /api/uploads/${fileName}` });

      await mint(viewer, fileName).expect(200);
    });

    it("keeps the uploader's own references granting, even after the uploader leaves the pod", async () => {
      const fileName = 'user-o-17-pod.png';
      const { owner, viewer, pod } = await seed({ fileName });
      await Post.create({ userId: owner._id, content: `public /api/uploads/${fileName}` });
      await Pod.updateOne({ _id: pod._id }, { $pull: { members: owner._id } });

      await mint(viewer, fileName).expect(200);
    });

    it("keeps the uploader's PG message reference granting in its pod", async () => {
      const fileName = 'user-o-18-pod.png';
      const { owner, viewer } = await seed({ fileName });
      const other = await Pod.create({
        name: 'other', type: 'chat', createdBy: owner._id, members: [owner._id, viewer._id],
      });
      mockPgPool.query.mockResolvedValue({
        rows: [{ pod_id: other._id.toString(), user_id: owner._id.toString() }],
      });

      await mint(viewer, fileName).expect(200);
    });

    it('grants through an eligible reference even when an ineligible one is also present', async () => {
      const fileName = 'user-o-19-pod.png';
      const { owner, author, viewer } = await seed({ fileName });
      await Post.create({ userId: author._id, content: `x /api/uploads/${fileName}` });
      await Post.create({ userId: owner._id, content: `y /api/uploads/${fileName}` });

      await mint(viewer, fileName).expect(200);
    });
  });

  it('allows mint when PG messages reference the file across multiple pods and viewer is in one (fix #3)', async () => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const viewerToken = generateTestToken(viewer._id);
    const podA = await Pod.create({
      name: 'A',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id],
    });
    const podB = await Pod.create({
      name: 'B',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id, viewer._id],
    });
    await File.create({
      fileName: 'chat-attachment.png',
      originalName: 'x.png',
      contentType: 'image/png',
      size: 10,
      uploadedBy: owner._id,
    });
    // PG returns BOTH pods referencing the file. With the pre-fix LIMIT 1
    // query, an arbitrary single pod would come back — if it was pod A, the
    // viewer (member of B, not A) would be denied.
    mockPgPool.query.mockResolvedValue({
      rows: [{ pod_id: podA._id.toString() }, { pod_id: podB._id.toString() }],
    });

    const res = await request(app)
      .get('/api/uploads/chat-attachment.png/url')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    expect(res.body.url).toMatch(/^\/api\/uploads\/chat-attachment\.png\?t=/);

    // Audit log is fire-and-forget. setImmediate only flushes microtasks —
    // the Mongo write itself is async I/O, so poll briefly until it lands.
    let log = null;
    for (let i = 0; i < 50 && !log; i++) {
      log = await AuditLog.findOne({
        action: 'attachment.token.mint',
        fileName: 'chat-attachment.png',
      });
      if (!log) await new Promise((r) => setTimeout(r, 20));
    }
    expect(log).toBeTruthy();
    expect(String(log.userId)).toBe(String(viewer._id));
  });

  it('enforces the rate limit — 31st mint in a minute returns 429 (per-token bucket)', async () => {
    const owner = await makeUser();
    const token = generateTestToken(owner._id);
    await File.create({
      fileName: 'rate-limit-target.png',
      originalName: 'x.png',
      contentType: 'image/png',
      size: 10,
      uploadedBy: owner._id,
    });

    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .get('/api/uploads/rate-limit-target.png/url')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }
    await request(app)
      .get('/api/uploads/rate-limit-target.png/url')
      .set('Authorization', `Bearer ${token}`)
      .expect(429);
  });
});
