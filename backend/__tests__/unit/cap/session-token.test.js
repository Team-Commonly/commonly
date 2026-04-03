/**
 * CAP Phase 1 — session-token endpoint integration tests
 *
 * Tests POST /api/registry/admin/agents/claude-code/session-token:
 * - Happy path: 200, token format, expiresAt
 * - Token stored hashed on agentRuntimeTokens
 * - AgentInstallation created with runtimeType: 'claude-code'
 * - Pod membership added for the agent user
 * - Each call issues a fresh token (never reused)
 * - expiresIn override is respected
 * - Missing podId → 400
 * - Non-existent podId → 404
 */

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');

// Models
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');

// Route under test
const registryRoutes = require('../../../routes/registry');

// Utils
const { hash } = require('../../../utils/secret');

const JWT_SECRET = 'test-cap-session-token-secret';
jest.setTimeout(60000);

// ── middleware mocks ──────────────────────────────────────────────────────────
// Use a mutable holder so the factory (hoisted by Jest) can reference the
// current admin user without closing over an undefined variable.
const currentAdminUser = { value: null };

jest.mock('../../../middleware/auth', () => jest.fn((req, _res, next) => {
  const u = currentAdminUser.value;
  req.user = { _id: u._id, id: u._id.toString(), role: 'admin' };
  req.userId = u._id.toString();
  next();
}));

// adminAuth just checks req.user.role — the auth mock already sets role: 'admin',
// but adminAuth also calls User.findById. Bypass it entirely.
jest.mock('../../../middleware/adminAuth', () => jest.fn((_req, _res, next) => next()));

// ── app ───────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

// ── fixtures ──────────────────────────────────────────────────────────────────

let mongod;
let adminUser;
let testPod;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;

  mongod = await MongoMemoryServer.create({
    binary: { version: '7.0.11', skipMD5: true },
    instance: { dbName: 'cap-session-token-test' },
  });
  await mongoose.connect(mongod.getUri());

  adminUser = await User.create({
    username: 'cap-admin',
    email: 'cap-admin@test.local',
    password: 'Password123!',
    role: 'admin',
  });
  currentAdminUser.value = adminUser;

  testPod = await Pod.create({
    name: 'Dev Team',
    description: 'Test pod',
    type: 'chat',
    createdBy: adminUser._id,
    members: [adminUser._id],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  // Clean up agent users and installations; restore pod to original membership
  await User.deleteMany({ isBot: true });
  await AgentInstallation.deleteMany({});
  await Pod.findByIdAndUpdate(testPod._id, { members: [adminUser._id] });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/registry/admin/agents/claude-code/session-token', () => {
  test('returns 200 with token starting cm_agent_ and expiresAt ~24h from now', async () => {
    const before = Date.now();
    const res = await request(app)
      .post('/api/registry/admin/agents/claude-code/session-token')
      .set('Authorization', `Bearer ${jwt.sign({ id: adminUser._id }, JWT_SECRET)}`)
      .send({ podId: testPod._id.toString() });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cm_agent_[a-f0-9]+$/);
    expect(res.body.agentName).toBe('claude-code');
    expect(res.body.podId).toBe(testPod._id.toString());
    expect(res.body.podName).toBe('Dev Team');
    expect(res.body.instanceId).toBeTruthy();

    const expiresAt = new Date(res.body.expiresAt).getTime();
    const expected24h = before + 86400000;
    expect(expiresAt).toBeGreaterThanOrEqual(expected24h - 10000);
    expect(expiresAt).toBeLessThanOrEqual(expected24h + 10000);
  });

  test('stores the token as SHA-256 hash (not plaintext) on agentRuntimeTokens', async () => {
    const res = await request(app)
      .post('/api/registry/admin/agents/claude-code/session-token')
      .send({ podId: testPod._id.toString(), instanceId: 'hash-check' });

    expect(res.status).toBe(200);
    const rawToken = res.body.token;

    const agentUser = await User.findOne({ isBot: true, botType: 'agent' });
    expect(agentUser).toBeTruthy();

    const storedEntry = agentUser.agentRuntimeTokens.find(
      (t) => t.tokenHash === hash(rawToken),
    );
    expect(storedEntry).toBeTruthy();

    // The raw token must NOT appear as any stored hash
    const rawAppears = agentUser.agentRuntimeTokens.some(
      (t) => t.tokenHash === rawToken,
    );
    expect(rawAppears).toBe(false);
  });

  test('creates AgentInstallation with runtimeType claude-code and status active', async () => {
    const res = await request(app)
      .post('/api/registry/admin/agents/claude-code/session-token')
      .send({ podId: testPod._id.toString(), instanceId: 'install-check' });

    expect(res.status).toBe(200);

    const installation = await AgentInstallation.findOne({
      agentName: 'claude-code',
      podId: testPod._id,
      instanceId: 'install-check',
    });

    expect(installation).toBeTruthy();
    expect(installation.status).toBe('active');
    // config is a Mongoose Map — access via .get()
    const runtimeConfig = installation.config?.get('runtime');
    expect(runtimeConfig?.runtimeType).toBe('claude-code');
    expect(installation.scopes).toContain('messages:write');
  });

  test('adds the claude-code agent user as a pod member', async () => {
    const res = await request(app)
      .post('/api/registry/admin/agents/claude-code/session-token')
      .send({ podId: testPod._id.toString(), instanceId: 'membership-check' });

    expect(res.status).toBe(200);

    const agentUser = await User.findOne({ isBot: true, botType: 'agent' });
    const pod = await Pod.findById(testPod._id);
    const isMember = pod.members.some((m) => m.toString() === agentUser._id.toString());
    expect(isMember).toBe(true);
  });

  test('second call with same instanceId issues a NEW token (never reuses)', async () => {
    const first = await request(app)
      .post('/api/registry/admin/agents/claude-code/session-token')
      .send({ podId: testPod._id.toString(), instanceId: 'reuse-check' });

    const second = await request(app)
      .post('/api/registry/admin/agents/claude-code/session-token')
      .send({ podId: testPod._id.toString(), instanceId: 'reuse-check' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.token).not.toBe(second.body.token);
  });

  test('expiresIn: 3600 sets expiresAt ~1h from now', async () => {
    const before = Date.now();
    const res = await request(app)
      .post('/api/registry/admin/agents/claude-code/session-token')
      .send({ podId: testPod._id.toString(), expiresIn: 3600 });

    expect(res.status).toBe(200);

    const expiresAt = new Date(res.body.expiresAt).getTime();
    const expected1h = before + 3600000;
    expect(expiresAt).toBeGreaterThanOrEqual(expected1h - 10000);
    expect(expiresAt).toBeLessThanOrEqual(expected1h + 10000);
  });

  test('returns 400 when podId is missing', async () => {
    const res = await request(app)
      .post('/api/registry/admin/agents/claude-code/session-token')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/podId/i);
  });

  test('returns 404 when pod does not exist', async () => {
    const nonExistentId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post('/api/registry/admin/agents/claude-code/session-token')
      .send({ podId: nonExistentId });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/pod not found/i);
  });
});
