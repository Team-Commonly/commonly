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

    // Audit log is fire-and-forget — give the microtask a beat, then verify.
    await new Promise((r) => setImmediate(r));
    const log = await AuditLog.findOne({
      action: 'attachment.token.mint',
      fileName: 'chat-attachment.png',
    });
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
