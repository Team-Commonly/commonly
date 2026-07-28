process.env.PG_HOST = '';
process.env.JWT_SECRET = 'discover-join-test-secret';

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
const { PodInvite } = require('../../models/PodInvite');
const podRoutes = require('../../routes/pods');
const podInvitesRoutes = require('../../routes/podInvites');
const adminPodsRoutes = require('../../routes/admin/pods');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

describe('POST /api/pods/:id/join discovery gate', () => {
  let app;
  let viewer;
  let owner;
  let admin;
  let viewerToken;
  let adminToken;

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    // Keep production ownership order: invite routes must precede the pods
    // catch-all so /api/pods/:podId/invites remains reachable (#712).
    app.use('/api', podInvitesRoutes);
    app.use('/api/pods', podRoutes);
    app.use('/api/admin/pods', adminPodsRoutes);
  });

  beforeEach(async () => {
    await clearMongoDb();
    viewer = await User.create({
      username: `discover-viewer-${Date.now()}`,
      email: `discover-viewer-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
    });
    owner = await User.create({
      username: `discover-owner-${Date.now()}`,
      email: `discover-owner-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
    });
    admin = await User.create({
      username: `discover-admin-${Date.now()}`,
      email: `discover-admin-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
      role: 'admin',
    });
    viewerToken = jwt.sign({ id: viewer._id }, process.env.JWT_SECRET);
    adminToken = jwt.sign({ id: admin._id }, process.env.JWT_SECRET);
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  const createPod = (overrides = {}) => Pod.create({
    name: `Join test ${Math.random()}`,
    type: 'team',
    createdBy: owner._id,
    members: [owner._id],
    publicRead: true,
    communityListed: true,
    joinPolicy: 'open',
    ...overrides,
  });

  const join = (podId, token = viewerToken) => request(app)
    .post(`/api/pods/${podId}/join`)
    .set('Authorization', `Bearer ${token}`);

  const setListing = (podId, communityListed, token = adminToken) => request(app)
    .post(`/api/admin/pods/${podId}/listing`)
    .set('Authorization', `Bearer ${token}`)
    .send({ communityListed });

  const setShowcase = (podId, publicRead, token = adminToken) => request(app)
    .post(`/api/admin/pods/${podId}/showcase`)
    .set('Authorization', `Bearer ${token}`)
    .send({ publicRead });

  it('joins a listed open pod atomically and makes repeat joins idempotent', async () => {
    const pod = await createPod();

    const first = await join(pod._id).expect(200);
    const second = await join(pod._id).expect(200);

    expect(first.body.members.map((member) => member._id)).toContain(String(viewer._id));
    expect(second.body.members.map((member) => member._id)).toContain(String(viewer._id));
    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.members.map(String).filter((id) => id === String(viewer._id))).toHaveLength(1);
  });

  it('refuses direct self-join to an open but unlisted pod', async () => {
    const pod = await createPod({ communityListed: false });

    const res = await join(pod._id).expect(403);

    expect(res.body.code).toBe('join_refused');
    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.members.map(String)).not.toContain(String(viewer._id));
  });

  it('refuses direct self-join to a listed pod that is not publicly readable', async () => {
    const pod = await createPod({ publicRead: false, communityListed: true });

    const res = await join(pod._id).expect(403);

    expect(res.body.code).toBe('join_refused');
    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.members.map(String)).not.toContain(String(viewer._id));
  });

  it('returns 200 for an existing member even when the pod is not directly joinable', async () => {
    const pod = await createPod({
      communityListed: false,
      joinPolicy: 'invite-only',
      members: [owner._id, viewer._id],
    });

    const res = await join(pod._id).expect(200);

    expect(res.body.members.map((member) => member._id)).toContain(String(viewer._id));
    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.members.map(String).filter((id) => id === String(viewer._id))).toHaveLength(1);
  });

  it('refuses direct self-join to a listed invite-only pod', async () => {
    const pod = await createPod({ joinPolicy: 'invite-only' });

    const res = await join(pod._id).expect(403);

    expect(res.body.code).toBe('join_refused');
  });

  it('keeps a listed invite-only pod discoverable without making it directly joinable', async () => {
    const pod = await createPod({ joinPolicy: 'invite-only' });

    const discover = await request(app)
      .get('/api/pods?scope=discover')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);

    expect(discover.body.map((candidate) => candidate._id)).toContain(String(pod._id));
    const joinResponse = await join(pod._id).expect(403);
    expect(joinResponse.body.code).toBe('join_refused');
  });

  it('keeps the personal-DM refusal ahead of discovery eligibility', async () => {
    const pod = await createPod({ type: 'agent-dm' });

    const res = await join(pod._id).expect(403);

    expect(res.body.msg).toMatch(/1:1.*third-person/i);
    expect(res.body.code).not.toBe('join_refused');
  });

  it('retains the global-admin bypass for non-DM pods', async () => {
    const pod = await createPod({ communityListed: false, joinPolicy: 'invite-only' });

    await join(pod._id, adminToken).expect(200);

    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.members.map(String)).toContain(String(admin._id));
  });

  it('keeps invite redemption as the distinct rail into invite-only pods', async () => {
    const pod = await createPod({ communityListed: false, joinPolicy: 'invite-only' });
    const token = 'a'.repeat(32);
    await PodInvite.create({ token, podId: pod._id, createdBy: owner._id });

    await request(app)
      .post(`/api/invites/${token}/redeem`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);

    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh.members.map(String)).toContain(String(viewer._id));
  });

  describe('admin community listing toggle', () => {
    it('requires a global admin', async () => {
      const pod = await createPod({ communityListed: false });

      await setListing(pod._id, true, viewerToken).expect(403);

      const fresh = await Pod.findById(pod._id).lean();
      expect(fresh.communityListed).toBe(false);
    });

    it('lists and unlists a publicly readable pod with an audit record', async () => {
      const pod = await createPod({ communityListed: false });

      const listed = await setListing(pod._id, true).expect(200);
      expect(listed.body).toEqual({
        id: String(pod._id),
        publicRead: true,
        communityListed: true,
      });

      const unlisted = await setListing(pod._id, false).expect(200);
      expect(unlisted.body.communityListed).toBe(false);

      const fresh = await Pod.findById(pod._id).lean();
      expect(fresh.communityListed).toBe(false);
      const actions = await AuditLog.find({ target: String(pod._id) }).sort({ createdAt: 1 }).lean();
      expect(actions.map((entry) => entry.action)).toEqual(['community.list', 'community.unlist']);
    });

    it('rejects a non-boolean body', async () => {
      const pod = await createPod({ communityListed: false });

      const res = await request(app)
        .post(`/api/admin/pods/${pod._id}/listing`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ communityListed: 'yes' })
        .expect(400);

      expect(res.body.error).toMatch(/boolean/);
    });

    it('returns 404 when the pod does not exist', async () => {
      await setListing('0123456789abcdef01234567', true).expect(404);
    });

    it('refuses to list a pod that is not publicly readable', async () => {
      const pod = await createPod({ publicRead: false, communityListed: false });

      const res = await setListing(pod._id, true).expect(409);

      expect(res.body).toMatchObject({
        error: 'listing_requires_public_read',
        message: expect.stringContaining(`/api/admin/pods/${pod._id}/showcase`),
      });
      const fresh = await Pod.findById(pod._id).lean();
      expect(fresh.communityListed).toBe(false);
    });

    it('allows unlisting a non-public pod without requiring it to be republished', async () => {
      const pod = await createPod({ publicRead: false, communityListed: true });

      const res = await setListing(pod._id, false).expect(200);

      expect(res.body).toMatchObject({ publicRead: false, communityListed: false });
    });

    it.each(['agent-room', 'agent-dm', 'agent-admin'])(
      'refuses listing changes for personal pod type %s',
      async (type) => {
        const pod = await createPod({ type, communityListed: false });

        await setListing(pod._id, true).expect(400);

        const fresh = await Pod.findById(pod._id).lean();
        expect(fresh.communityListed).toBe(false);
      },
    );
  });

  it('unpublishing a listed pod cascades the community unlist', async () => {
    const pod = await createPod();

    const res = await setShowcase(pod._id, false).expect(200);

    expect(res.body).toEqual({
      id: String(pod._id),
      publicRead: false,
      communityListed: false,
    });
    const fresh = await Pod.findById(pod._id).lean();
    expect(fresh).toMatchObject({ publicRead: false, communityListed: false });
    const audit = await AuditLog.findOne({
      target: String(pod._id),
      action: 'showcase.unpublish',
    }).lean();
    expect(audit.detail).toContain('communityListed=false cascade=unlisted');
  });
});
