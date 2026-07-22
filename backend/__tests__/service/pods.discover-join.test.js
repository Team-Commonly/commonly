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
const { PodInvite } = require('../../models/PodInvite');
const podRoutes = require('../../routes/pods');
const podInvitesRoutes = require('../../routes/podInvites');
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
});
