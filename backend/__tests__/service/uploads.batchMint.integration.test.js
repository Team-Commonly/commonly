/**
 * Batch signed-URL mint: `POST /api/uploads/urls`.
 *
 * A pod chat renders one thumbnail per image message, and each used to mint its
 * own signed URL. The mint limiter allows 30 per minute per token, so a pod with
 * more than 30 images on screen 429'd its own viewer (D215 crawl of prod,
 * 2026-11-04). The batch route mints a page of names in one request, and that
 * request counts ONCE against the same per-token bucket as the single route, so
 * the limit still bounds what one token can mint.
 *
 * Every name goes through the same authorization as a single mint
 * (canReadAttachment). A name the caller cannot read is refused on its own and
 * the rest are still minted.
 *
 * Real MongoMemoryServer for User/Pod/Post/File/AuditLog, PG pool mocked as in
 * uploads.signedurl.integration.test.js.
 */

const express = require('express');
const request = require('supertest');

const {
  setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken, 
} = require('../utils/testUtils');

const mockPgPool = { query: jest.fn() };
jest.mock('../../config/db-pg', () => ({ pool: mockPgPool }));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Post = require('../../models/Post');
const File = require('../../models/File');
const AuditLog = require('../../models/AuditLog');
const { verifyAttachmentToken } = require('../../services/attachmentAccess');

const uploadsRoutes = require('../../routes/uploads');

const PAGE = 50;

describe('POST /api/uploads/urls — batch signed-URL mint', () => {
  let app;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-batch-mint';
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

  // Each test gets its own user, so its own token, so its own limiter bucket:
  // the bucket is keyed on the Authorization header.
  async function makeUser(override = {}) {
    return User.create({
      username: `u-${Math.random().toString(36).slice(2, 10)}`,
      email: `${Math.random().toString(36).slice(2, 10)}@test.com`,
      password: 'Password123!',
      ...override,
    });
  }

  async function ownFiles(owner, count, prefix = 'own') {
    const names = Array.from({ length: count }, (_, i) => `${prefix}-${i}.png`);
    await File.insertMany(names.map((fileName) => ({
      fileName, originalName: fileName, contentType: 'image/png', size: 10, uploadedBy: owner._id,
    })));
    return names;
  }

  const mint = (token, fileNames) => request(app)
    .post('/api/uploads/urls')
    .set('Authorization', `Bearer ${token}`)
    .send({ fileNames });

  it('mints a 50-name page in one request, with no 429, and each URL carries a token for its own file', async () => {
    const owner = await makeUser();
    const token = generateTestToken(owner._id);
    const names = await ownFiles(owner, PAGE);

    const res = await mint(token, names);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.urls).sort()).toEqual([...names].sort());
    names.forEach((name) => {
      const { url, expiresIn } = res.body.urls[name];
      expect(url.startsWith(`/api/uploads/${name}?t=`)).toBe(true);
      expect(expiresIn).toBeGreaterThan(0);
      const t = decodeURIComponent(url.split('?t=')[1]);
      expect(verifyAttachmentToken(t, name)).toBeTruthy();
      // A token is bound to its own file: it must not open a sibling.
      expect(verifyAttachmentToken(t, names.find((other) => other !== name))).toBeFalsy();
    });
    expect(res.body.refused).toEqual([]);
  });

  it('refuses only the names the caller cannot read, and still mints the rest (mixed batch)', async () => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const viewerToken = generateTestToken(viewer._id);
    const pod = await Pod.create({
      name: 'private', type: 'chat', createdBy: owner._id, members: [owner._id], 
    });
    await File.create({
      fileName: 'private.png', originalName: 'p.png', contentType: 'image/png', size: 10, uploadedBy: owner._id, 
    });
    await Post.create({
      userId: owner._id, podId: pod._id, content: 'x', image: '/api/uploads/private.png', 
    });
    const mine = await ownFiles(viewer, 2, 'viewer');

    const res = await mint(viewerToken, [mine[0], 'private.png', 'no-such-file.png', mine[1]]);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.urls).sort()).toEqual([...mine].sort());
    expect(res.body.urls['private.png']).toBeUndefined();
    expect(res.body.refused.sort()).toEqual(['no-such-file.png', 'private.png']);
    // The minted names each leave an audit row; the refused ones leave none. The
    // writes are fire-and-forget, so wait for them, and read only this viewer's.
    const auditedFor = async () => (await AuditLog.find({ userId: viewer._id }).lean()).map((row) => row.fileName).sort();
    // eslint-disable-next-line no-await-in-loop
    for (let i = 0; i < 50 && (await auditedFor()).length < mine.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    expect(await auditedFor()).toEqual([...mine].sort());
  });

  it('counts a batch once against the per-token bucket the single route uses', async () => {
    const owner = await makeUser();
    const token = generateTestToken(owner._id);
    const names = await ownFiles(owner, 3);

    // 29 batches plus one single mint fill the 30-per-minute bucket together...
    for (let i = 0; i < 29; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await mint(token, names).expect(200);
    }
    await request(app).get(`/api/uploads/${names[0]}/url`).set('Authorization', `Bearer ${token}`).expect(200);
    // ...so the next request of either kind is refused.
    await mint(token, names).expect(429);
    await request(app).get(`/api/uploads/${names[0]}/url`).set('Authorization', `Bearer ${token}`).expect(429);
  });

  it('refuses a malformed body before minting anything', async () => {
    const owner = await makeUser();
    const token = generateTestToken(owner._id);
    const names = await ownFiles(owner, PAGE + 1);

    await mint(token, names).expect(400); // over the page cap
    await mint(token, []).expect(400);
    await mint(token, 'own-0.png').expect(400);
    await mint(token, ['own-0.png', 7]).expect(400);
    await request(app).post('/api/uploads/urls').send({ fileNames: ['own-0.png'] }).expect(401);
  });

  it('mints a repeated name once', async () => {
    const owner = await makeUser();
    const token = generateTestToken(owner._id);
    const [name] = await ownFiles(owner, 1);

    const res = await mint(token, [name, name, name]).expect(200);
    expect(Object.keys(res.body.urls)).toEqual([name]);
  });

  it('refuses a name that is not a plain upload name on its own, and still mints the rest', async () => {
    const owner = await makeUser();
    const token = generateTestToken(owner._id);
    const [name] = await ownFiles(owner, 1);
    const odd = ['../etc/passwd', 'a/b.png', 'a\\b.png', 'nul\u0000.png', 'a'.repeat(300)];

    const res = await mint(token, [name, ...odd]).expect(200);
    expect(Object.keys(res.body.urls)).toEqual([name]);
    expect(res.body.refused.sort()).toEqual([...odd].sort());
  });
});
