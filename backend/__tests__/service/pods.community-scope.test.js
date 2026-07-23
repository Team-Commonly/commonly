process.env.PG_HOST = '';
process.env.JWT_SECRET = 'community-scope-test-secret';

// This suite exercises route ownership and controller filtering, not JWT
// cryptography. Keep it runnable on Node 26, where jsonwebtoken's transitive
// SlowBuffer dependency is not yet compatible.
jest.mock('jsonwebtoken', () => ({
  sign: ({ id }) => `test-token:${id}`,
  verify: (token) => ({ id: token.replace('test-token:', '') }),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const podRoutes = require('../../routes/pods');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

describe('GET /api/pods community scope', () => {
  let app;
  let viewer;
  let otherUser;
  let viewerToken;
  let memberPod;
  let communityPod;
  let studyCommunityPod;
  let joinedCommunityPod;
  let inviteOnlyPod;
  let nonPublicListedPod;
  let showcasePod;
  let privatePod;
  let forcedPersonalPods;

  beforeAll(async () => {
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/pods', podRoutes);

    viewer = await User.create({
      username: 'community-viewer',
      email: 'community-viewer@test.com',
      password: 'Password123!',
      isVerified: true,
    });
    otherUser = await User.create({
      username: 'community-owner',
      email: 'community-owner@test.com',
      password: 'Password123!',
      isVerified: true,
    });
    viewerToken = jwt.sign({ id: viewer._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    memberPod = await Pod.create({
      name: 'My private team',
      type: 'team',
      createdBy: viewer._id,
      members: [viewer._id],
      publicRead: false,
    });
    communityPod = await Pod.create({
      name: 'Public community pod',
      type: 'team',
      createdBy: otherUser._id,
      members: [otherUser._id],
      publicRead: true,
      communityListed: true,
      joinPolicy: 'open',
    });
    studyCommunityPod = await Pod.create({
      name: 'Public study community pod',
      type: 'study',
      createdBy: otherUser._id,
      members: [otherUser._id],
      publicRead: true,
      communityListed: true,
      joinPolicy: 'open',
    });
    joinedCommunityPod = await Pod.create({
      name: 'Already joined community pod',
      type: 'team',
      createdBy: otherUser._id,
      members: [otherUser._id, viewer._id],
      publicRead: true,
      communityListed: true,
      joinPolicy: 'open',
    });
    inviteOnlyPod = await Pod.create({
      name: 'Invite-only community pod',
      type: 'team',
      createdBy: otherUser._id,
      members: [otherUser._id],
      publicRead: true,
      communityListed: true,
      joinPolicy: 'invite-only',
    });
    nonPublicListedPod = await Pod.create({
      name: 'Listed but not publicly readable',
      type: 'team',
      createdBy: otherUser._id,
      members: [otherUser._id],
      publicRead: false,
      communityListed: true,
      joinPolicy: 'open',
    });
    // Readable but NOT listed — the showcase-room shape (Eng Milestone etc.):
    // anonymous read access stays, Community tab must not surface it.
    showcasePod = await Pod.create({
      name: 'Showcase room (readable, unlisted)',
      type: 'team',
      createdBy: otherUser._id,
      members: [otherUser._id],
      publicRead: true,
      communityListed: false,
    });
    privatePod = await Pod.create({
      name: 'Other private team',
      type: 'team',
      createdBy: otherUser._id,
      members: [otherUser._id],
      publicRead: false,
    });
    forcedPersonalPods = await Promise.all(['agent-room', 'agent-dm', 'agent-admin'].map((type) => (
      Pod.create({
        name: `Forced public ${type}`,
        type,
        createdBy: otherUser._id,
        members: [otherUser._id],
        // These rows bypass the admin toggle deliberately. The discovery
        // query must remain safe even if legacy/manual data is malformed —
        // even when BOTH flags are (wrongly) set on a personal pod type.
        publicRead: true,
        communityListed: true,
      })
    )));
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  it('returns only listed public pods the caller has joined', async () => {
    const res = await request(app)
      .get('/api/pods?scope=community')
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((pod) => pod._id);
    expect(ids).toEqual([joinedCommunityPod._id.toString()]);
    expect(ids).not.toContain(communityPod._id.toString());
    expect(ids).not.toContain(studyCommunityPod._id.toString());
    expect(ids).not.toContain(inviteOnlyPod._id.toString());
    expect(ids).not.toContain(privatePod._id.toString());
    expect(ids).not.toContain(nonPublicListedPod._id.toString());
    // Readable-but-unlisted showcase rooms must stay OFF the Community tab.
    expect(ids).not.toContain(showcasePod._id.toString());
    forcedPersonalPods.forEach((pod) => {
      expect(ids).not.toContain(pod._id.toString());
    });
  });

  it('discovers only listed, readable, joinable pods the caller has not joined', async () => {
    const res = await request(app)
      .get('/api/pods?scope=discover')
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((pod) => pod._id);
    expect(ids).toEqual(expect.arrayContaining([
      communityPod._id.toString(),
      studyCommunityPod._id.toString(),
    ]));
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(joinedCommunityPod._id.toString());
    expect(ids).not.toContain(inviteOnlyPod._id.toString());
    expect(ids).not.toContain(showcasePod._id.toString());
    expect(ids).not.toContain(nonPublicListedPod._id.toString());
    forcedPersonalPods.forEach((pod) => {
      expect(ids).not.toContain(pod._id.toString());
    });
  });

  it('honors the optional type filter in discover scope', async () => {
    const res = await request(app)
      .get('/api/pods?scope=discover&type=study')
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.map((pod) => pod._id)).toEqual([studyCommunityPod._id.toString()]);
  });

  it('keeps the default listing membership-only for the same fixtures', async () => {
    const res = await request(app)
      .get('/api/pods')
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.map((pod) => pod._id)).toEqual(expect.arrayContaining([
      memberPod._id.toString(),
      joinedCommunityPod._id.toString(),
    ]));
    expect(res.body).toHaveLength(2);
    expect(res.body.map((pod) => pod._id)).not.toContain(communityPod._id.toString());
  });

  it('still requires authentication', async () => {
    const res = await request(app).get('/api/pods?scope=community');

    expect(res.status).toBe(401);
  });
});
