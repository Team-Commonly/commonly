/**
 * A person's profile, read by someone else, carries only what that viewer may
 * see: the pods the two of them share (never a personal pod), and the public
 * fields of the account. Real models against in-memory Mongo, so the pod query
 * is exercised as Mongo answers it, not as a mock assumes.
 */
const request = require('supertest');
const express = require('express');
const userRoutes = require('../../routes/users');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  generateTestToken,
} = require('../utils/testUtils');

const makeUser = (username, fields = {}) => User.create({
  username, email: `${username}@example.test`, password: 'Password123!', ...fields,
});
const makePod = (name, type, members) => Pod.create({
  name, type, members: members.map((m) => m._id), createdBy: members[0]._id,
});

describe('profile reads are scoped to the viewer', () => {
  let app;

  beforeAll(async () => {
    await setupMongoDb();
    process.env.JWT_SECRET = 'test-jwt-secret';
    app = express();
    app.use(express.json());
    app.use('/api/users', userRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  const activity = (viewer, target) => request(app)
    .get(`/api/users/${target._id}/public-activity`)
    .set('Authorization', `Bearer ${generateTestToken(viewer._id)}`)
    .expect(200);

  describe('GET /api/users/:id/public-activity', () => {
    let target;
    let viewer;
    let agent;

    beforeEach(async () => {
      target = await makeUser('target');
      viewer = await makeUser('viewer');
      agent = await makeUser('helper-agent', { isBot: true, botType: 'agent' });
      await makePod('Shared team', 'team', [target, viewer]);
      await makePod('Shared chat', 'chat', [viewer, target]);
      await makePod('Target only', 'team', [target]);
      await makePod('Target and agent room', 'agent-room', [target, agent]);
      await makePod('Target agent admin', 'agent-admin', [target, agent]);
      // Both are members, and it is still a personal pod, so it never lists.
      await makePod('Viewer and target dm', 'agent-dm', [target, viewer]);
    });

    it('lists only the pods the viewer shares with the person, never a personal pod', async () => {
      const res = await activity(viewer, target);
      expect(res.body.joinedPods.map((p) => p.name).sort()).toEqual(['Shared chat', 'Shared team']);
    });

    it('lists nothing to a viewer who shares no pod with the person', async () => {
      const stranger = await makeUser('stranger');
      const res = await activity(stranger, target);
      expect(res.body.joinedPods).toEqual([]);
    });

    it('lists a person their own non-personal pods', async () => {
      const res = await activity(target, target);
      expect(res.body.joinedPods.map((p) => p.name).sort())
        .toEqual(['Shared chat', 'Shared team', 'Target only']);
    });
  });

  describe('GET /api/users/:id', () => {
    let target;
    let viewer;

    beforeEach(async () => {
      viewer = await makeUser('viewer');
      const pod = await makePod('Private', 'team', [viewer]);
      target = await makeUser('target', {
        displayName: 'Target Person',
        timezone: 'America/Los_Angeles',
        billing: { customerId: 'cus_test123', subscriptionId: 'sub_test123', subscriptionStatus: 'active' },
        subscribedPods: [pod._id],
        followers: [viewer._id],
      });
      await User.updateOne({ _id: target._id }, {
        $set: { followedThreads: [{ postId: pod._id, followedAt: new Date() }] },
      }, { strict: false });
    });

    it('gives another viewer the public profile only', async () => {
      const res = await request(app)
        .get(`/api/users/${target._id}`)
        .set('Authorization', `Bearer ${generateTestToken(viewer._id)}`)
        .expect(200);

      expect(res.body).toMatchObject({
        _id: String(target._id),
        username: 'target',
        displayName: 'Target Person',
        followersCount: 1,
        followingCount: 0,
        isFollowing: true,
      });
      for (const field of ['email', 'billing', 'subscribedPods', 'followedThreads', 'followedThreadsCount',
        'followers', 'following', 'timezone', 'tokenVersion', 'onboarding', 'emailPreferences',
        'digestPreferences']) {
        expect(res.body).not.toHaveProperty(field);
      }
    });

    it("gives another viewer an agent's identity, not its machine, runtime or owner", async () => {
      const agent = await makeUser('helper-agent', {
        isBot: true,
        botType: 'agent',
        botMetadata: {
          displayName: 'Helper', description: 'Answers questions', agentName: 'helper', instanceId: 'default',
          runtimeId: 'rt-1', ownerUserId: String(viewer._id), machineId: 'machine-1',
        },
      });
      const res = await request(app)
        .get(`/api/users/${agent._id}`)
        .set('Authorization', `Bearer ${generateTestToken(viewer._id)}`)
        .expect(200);

      expect(res.body.botMetadata).toMatchObject({ displayName: 'Helper', agentName: 'helper', instanceId: 'default' });
      for (const field of ['runtimeId', 'ownerUserId', 'machineId', 'requestedMachineId', 'reconnectRequestedAt']) {
        expect(res.body.botMetadata).not.toHaveProperty(field);
      }
      expect(res.body).not.toHaveProperty('agentConfig');
    });

    it('still gives the account holder their own account fields', async () => {
      const res = await request(app)
        .get(`/api/users/${target._id}`)
        .set('Authorization', `Bearer ${generateTestToken(target._id)}`)
        .expect(200);

      expect(res.body.email).toBe('target@example.test');
      expect(res.body.followedThreadsCount).toBe(1);
      expect(res.body.billing).toMatchObject({ subscriptionStatus: 'active' });
      expect(res.body).not.toHaveProperty('password');
    });
  });
});
