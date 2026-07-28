/**
 * #772 — the community-listing writer.
 *
 * `communityListed` gates both discovery scopes and the direct-join path, but
 * had no HTTP writer: only a seed script or a hand-written Mongo write could
 * set it. These tests cover the new admin endpoint AND the invariant it exists
 * to protect — listed ⇒ readable — including the cascade from the sibling
 * showcase toggle, which could otherwise re-create the broken state.
 *
 * Service tier (real Mongo) rather than unit: the whole point is the persisted
 * state transition and the interaction between two endpoints plus the join
 * gate. Mocking the model away would test nothing that matters here.
 */
process.env.PG_HOST = '';
process.env.JWT_SECRET = 'community-listing-test-secret';

jest.mock('jsonwebtoken', () => ({
  sign: ({ id }) => `test-token:${id}`,
  verify: (token) => ({ id: token.replace('test-token:', '') }),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');
const adminPodRoutes = require('../../routes/admin/pods');
const podRoutes = require('../../routes/pods');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

describe('POST /api/admin/pods/:podId/listing', () => {
  let app;
  let admin;
  let owner;
  let viewer;
  let adminToken;
  let viewerToken;

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/admin/pods', adminPodRoutes);
    app.use('/api/pods', podRoutes);
  });

  beforeEach(async () => {
    await clearMongoDb();
    admin = await User.create({
      username: `listing-admin-${Date.now()}`,
      email: `listing-admin-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
      role: 'admin',
    });
    owner = await User.create({
      username: `listing-owner-${Date.now()}`,
      email: `listing-owner-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
    });
    viewer = await User.create({
      username: `listing-viewer-${Date.now()}`,
      email: `listing-viewer-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
    });
    adminToken = jwt.sign({ id: admin._id }, process.env.JWT_SECRET);
    viewerToken = jwt.sign({ id: viewer._id }, process.env.JWT_SECRET);
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  const createPod = (overrides = {}) => Pod.create({
    name: `Listing test ${Math.random()}`,
    type: 'team',
    createdBy: owner._id,
    members: [owner._id],
    publicRead: false,
    communityListed: false,
    joinPolicy: 'open',
    ...overrides,
  });

  const setListing = (podId, communityListed, token = adminToken) => request(app)
    .post(`/api/admin/pods/${podId}/listing`)
    .set('Authorization', `Bearer ${token}`)
    .send({ communityListed });

  const setShowcase = (podId, publicRead, token = adminToken) => request(app)
    .post(`/api/admin/pods/${podId}/showcase`)
    .set('Authorization', `Bearer ${token}`)
    .send({ publicRead });

  it('lists a publicRead pod to Community', async () => {
    const pod = await createPod({ publicRead: true });

    const res = await setListing(pod._id, true).expect(200);

    expect(res.body).toMatchObject({ publicRead: true, communityListed: true });
    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.communityListed).toBe(true);
  });

  it('refuses to list a pod that is not publicRead, and leaves it untouched', async () => {
    const pod = await createPod({ publicRead: false });

    const res = await setListing(pod._id, true).expect(409);

    expect(res.body.code).toBe('listing_requires_public_read');
    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.communityListed).toBe(false);
  });

  it('always allows unlisting, including on a pod that is not publicRead', async () => {
    // Reachable on legacy rows written by the seed script before this endpoint
    // existed — unlisting must never be blocked by the publish precondition.
    const pod = await createPod({ publicRead: false, communityListed: true });

    await setListing(pod._id, false).expect(200);

    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.communityListed).toBe(false);
  });

  it('rejects personal pod types', async () => {
    const pod = await createPod({ type: 'agent-dm', publicRead: true });

    const res = await setListing(pod._id, true).expect(400);

    expect(res.body.error).toMatch(/personal pod type/i);
    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.communityListed).toBe(false);
  });

  it('requires a boolean body and a real pod', async () => {
    const pod = await createPod({ publicRead: true });

    await request(app)
      .post(`/api/admin/pods/${pod._id}/listing`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ communityListed: 'yes' })
      .expect(400);

    await setListing('507f1f77bcf86cd799439011', true).expect(404);
  });

  it('refuses a non-admin caller', async () => {
    const pod = await createPod({ publicRead: true });

    await setListing(pod._id, true, viewerToken).expect(403);

    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.communityListed).toBe(false);
  });

  it('audits the listing change', async () => {
    const pod = await createPod({ publicRead: true });

    await setListing(pod._id, true).expect(200);

    const entry = await AuditLog.findOne({ action: 'community.list' }).lean();
    expect(entry.target).toBe(String(pod._id));
    expect(String(entry.userId)).toBe(String(admin._id));
  });

  describe('the listed ⇒ readable invariant', () => {
    it('cascades an unlist when the showcase toggle unpublishes a listed pod', async () => {
      const pod = await createPod({ publicRead: true, communityListed: true });

      const res = await setShowcase(pod._id, false).expect(200);

      expect(res.body).toMatchObject({ publicRead: false, communityListed: false });
      const fresh = await Pod.findById(pod._id).lean();
      expect(fresh.communityListed).toBe(false);
    });

    it('leaves an unlisted pod alone when unpublishing', async () => {
      const pod = await createPod({ publicRead: true, communityListed: false });

      await setShowcase(pod._id, false).expect(200);

      const fresh = await Pod.findById(pod._id).lean();
      expect(fresh.communityListed).toBe(false);
      expect(fresh.publicRead).toBe(false);
    });
  });

  describe('end to end: listing is what unblocks joining', () => {
    const join = (podId) => request(app)
      .post(`/api/pods/${podId}/join`)
      .set('Authorization', `Bearer ${viewerToken}`);

    it('turns a refused join into an accepted one', async () => {
      const pod = await createPod({ publicRead: true, joinPolicy: 'open' });

      // The #772 starting state: open joinPolicy is a dormant bit.
      await join(pod._id).expect(403);

      await setListing(pod._id, true).expect(200);

      await join(pod._id).expect(200);
      const fresh = await Pod.findById(pod._id).lean();
      expect(fresh.members.map(String)).toContain(String(viewer._id));
    });

    it('does not make an invite-only pod joinable', async () => {
      const pod = await createPod({ publicRead: true, joinPolicy: 'invite-only' });

      await setListing(pod._id, true).expect(200);

      const res = await join(pod._id).expect(403);
      expect(res.body.code).toBe('join_refused');
    });
  });
});
