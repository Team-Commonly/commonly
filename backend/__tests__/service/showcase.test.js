const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Message = require('../../models/Message');
const showcaseRoutes = require('../../routes/showcase');
const adminPodsRoutes = require('../../routes/admin/pods');
const podRoutes = require('../../routes/pods');
const messageRoutes = require('../../routes/messages');
const contextApiRoutes = require('../../routes/contextApi');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

const { isShowcaseWorthy } = showcaseRoutes;

describe('Showcase (public read-only) routes', () => {
  let app;
  let adminToken;
  let memberToken;
  let adminUser;
  let humanUser;
  let botUser;
  let publicPod;
  let privatePod;
  let personalPod;
  // A real-but-nonexistent ObjectId — must 404 the SAME way a private pod does.
  const missingPodId = '0123456789abcdef01234567';

  beforeAll(async () => {
    await setupMongoDb();
    process.env.JWT_SECRET = 'test-jwt-secret';

    app = express();
    app.use(express.json());

    // Showcase mounted WITHOUT auth (it self-gates on publicRead).
    app.use('/api/showcase', showcaseRoutes);
    app.use('/api/admin/pods', adminPodsRoutes);
    // Generic routes keep their internal auth — used for the regression check.
    app.use('/api/pods', podRoutes);
    app.use('/api/messages', messageRoutes);
    app.use('/api/v1', contextApiRoutes);

    adminUser = new User({
      username: 'showcaseadmin',
      email: 'showcase-admin@test.com',
      password: 'Password123!',
      isVerified: true,
      role: 'admin',
    });
    await adminUser.save();

    humanUser = new User({
      username: 'showcasehuman',
      email: 'showcase-human@test.com',
      password: 'Password123!',
      isVerified: true,
    });
    await humanUser.save();

    botUser = new User({
      username: 'openclaw-pixel',
      email: 'bot-pixel@test.com',
      password: 'Password123!',
      isBot: true,
      botMetadata: { displayName: 'Pixel', agentName: 'openclaw', instanceId: 'pixel' },
    });
    await botUser.save();

    adminToken = jwt.sign({ id: adminUser._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    memberToken = jwt.sign({ id: humanUser._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    publicPod = new Pod({
      name: 'Public Showcase Pod',
      description: 'A pod on display',
      type: 'team',
      createdBy: humanUser._id,
      members: [humanUser._id, botUser._id],
      publicRead: true,
    });
    await publicPod.save();

    privatePod = new Pod({
      name: 'Private Pod',
      type: 'team',
      createdBy: humanUser._id,
      members: [humanUser._id],
      publicRead: false,
    });
    await privatePod.save();

    personalPod = new Pod({
      name: 'Agent Room',
      type: 'agent-room',
      createdBy: humanUser._id,
      members: [humanUser._id, botUser._id],
    });
    await personalPod.save();

    // Seed messages in the public pod: two substantive + four noise.
    await Message.create({
      podId: publicPod._id,
      userId: humanUser._id,
      content: 'Hello team, here is the plan for launch day.',
      messageType: 'text',
      createdAt: new Date('2026-01-01T00:00:01Z'),
    });
    await Message.create({
      podId: publicPod._id,
      userId: botUser._id,
      content: 'I drafted the quarterly summary with three key findings.',
      messageType: 'text',
      createdAt: new Date('2026-01-01T00:00:02Z'),
    });
    // Noise: system message.
    await Message.create({
      podId: publicPod._id,
      userId: humanUser._id,
      content: 'showcasehuman joined the pod',
      messageType: 'system',
      createdAt: new Date('2026-01-01T00:00:03Z'),
    });
    // Noise: NO_REPLY sentinel.
    await Message.create({
      podId: publicPod._id,
      userId: botUser._id,
      content: 'NO_REPLY',
      messageType: 'text',
      createdAt: new Date('2026-01-01T00:00:04Z'),
    });
    // Noise: whitespace-only content.
    await Message.create({
      podId: publicPod._id,
      userId: botUser._id,
      content: '   ',
      messageType: 'text',
      createdAt: new Date('2026-01-01T00:00:05Z'),
    });
    // Noise: runtime model-failure / error content.
    await Message.create({
      podId: publicPod._id,
      userId: botUser._id,
      content: '⚠️ Agent failed before reply: All models failed (4): openrouter/x: 401',
      messageType: 'text',
      createdAt: new Date('2026-01-01T00:00:06Z'),
    });
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  describe('GET /api/showcase/:podId', () => {
    it('returns 200 with whitelisted pod + members for a public pod (anon)', async () => {
      const res = await request(app).get(`/api/showcase/${publicPod._id}`);
      expect(res.status).toBe(200);
      expect(res.body.pod).toMatchObject({
        id: publicPod._id.toString(),
        name: 'Public Showcase Pod',
        type: 'team',
        memberCount: 2,
      });
      expect(Array.isArray(res.body.members)).toBe(true);
      expect(res.body.members.length).toBe(2);
      // Agent identity surfaced.
      expect(res.body.agents.length).toBe(1);
      expect(res.body.agents[0]).toMatchObject({ displayName: 'Pixel', agentName: 'openclaw', instanceId: 'pixel' });
    });

    it('NEVER leaks an email field anywhere in the response', async () => {
      const res = await request(app).get(`/api/showcase/${publicPod._id}`);
      const blob = JSON.stringify(res.body);
      expect(blob).not.toMatch(/email/i);
      expect(blob).not.toContain('@test.com');
    });

    it('returns 404 for a private (publicRead=false) pod — no oracle', async () => {
      const res = await request(app).get(`/api/showcase/${privatePod._id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    });

    it('returns the SAME 404 for a missing pod as for a private one', async () => {
      const res = await request(app).get(`/api/showcase/${missingPodId}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    });

    it('returns 404 for a non-ObjectId podId', async () => {
      const res = await request(app).get('/api/showcase/not-an-id');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    });
  });

  describe('GET /api/showcase/:podId/messages', () => {
    it('returns filtered, whitelisted messages for a public pod (anon)', async () => {
      const res = await request(app).get(`/api/showcase/${publicPod._id}/messages`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('hasMore');
      const contents = res.body.messages.map((m) => m.content);
      // Two substantive turns kept...
      expect(contents).toContain('Hello team, here is the plan for launch day.');
      expect(contents).toContain('I drafted the quarterly summary with three key findings.');
      // ...all four noise turns dropped.
      expect(contents).not.toContain('NO_REPLY');
      expect(contents).not.toContain('showcasehuman joined the pod');
      expect(contents.some((c) => c.includes('All models failed'))).toBe(false);
      expect(res.body.messages.length).toBe(2);
      // Author whitelist — no email leaked.
      expect(JSON.stringify(res.body)).not.toMatch(/email|@test\.com/i);
      const botMsg = res.body.messages.find((m) => m.author.isBot);
      expect(botMsg.author.displayName).toBe('Pixel');
    });

    it('returns 404 for a private pod', async () => {
      const res = await request(app).get(`/api/showcase/${privatePod._id}/messages`);
      expect(res.status).toBe(404);
    });
  });

  describe('isShowcaseWorthy noise-filter predicate', () => {
    it('keeps a real human/agent turn', () => {
      expect(isShowcaseWorthy({ content: 'Here is the report.', messageType: 'text' })).toBe(true);
    });
    it('drops empty / whitespace-only content', () => {
      expect(isShowcaseWorthy({ content: '   ', messageType: 'text' })).toBe(false);
      expect(isShowcaseWorthy({ content: '', messageType: 'text' })).toBe(false);
    });
    it('drops NO_REPLY sentinels', () => {
      expect(isShowcaseWorthy({ content: 'NO_REPLY', messageType: 'text' })).toBe(false);
    });
    it('drops system messages', () => {
      expect(isShowcaseWorthy({ content: 'x joined', messageType: 'system' })).toBe(false);
    });
    it('drops heartbeat / error / failover cruft', () => {
      expect(isShowcaseWorthy({ content: 'HEARTBEAT_OK', messageType: 'text' })).toBe(false);
      expect(isShowcaseWorthy({ content: 'Error reading the pod context', messageType: 'text' })).toBe(false);
      expect(isShowcaseWorthy({ content: 'All models failed (3): foo: 429', messageType: 'text' })).toBe(false);
    });
  });

  describe('REGRESSION: generic routes stay auth-gated (showcase did not relax them)', () => {
    it('anon GET /api/pods/:id is rejected (no anon access)', async () => {
      const res = await request(app).get(`/api/pods/${publicPod._id}`);
      expect([401, 403]).toContain(res.status);
    });
    it('anon GET /api/messages/:podId is 401', async () => {
      const res = await request(app).get(`/api/messages/${publicPod._id}`);
      expect(res.status).toBe(401);
    });
    it('anon GET a memory endpoint is 401', async () => {
      const res = await request(app).get(`/api/v1/pods/${publicPod._id}/memory/HEARTBEAT.md`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/admin/pods/:podId/showcase (admin toggle)', () => {
    it('requires admin (403 for a non-admin member)', async () => {
      const res = await request(app)
        .post(`/api/admin/pods/${privatePod._id}/showcase`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ publicRead: true });
      expect(res.status).toBe(403);
    });

    it('400s on a personal pod type (agent-room)', async () => {
      const res = await request(app)
        .post(`/api/admin/pods/${personalPod._id}/showcase`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ publicRead: true });
      expect(res.status).toBe(400);
      // And the pod must NOT have been flipped.
      const reloaded = await Pod.findById(personalPod._id);
      expect(reloaded.publicRead).toBe(false);
    });

    it('400s when publicRead is not a boolean', async () => {
      const res = await request(app)
        .post(`/api/admin/pods/${privatePod._id}/showcase`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ publicRead: 'yes' });
      expect(res.status).toBe(400);
    });

    it('flips publicRead for a normal pod as admin', async () => {
      const res = await request(app)
        .post(`/api/admin/pods/${privatePod._id}/showcase`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ publicRead: true });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: privatePod._id.toString(), publicRead: true });
      const reloaded = await Pod.findById(privatePod._id);
      expect(reloaded.publicRead).toBe(true);
    });
  });
});
