/**
 * ADR-010 Phase 1 — `POST /api/agents/runtime/room` dual-auth integration test.
 *
 * The route used to be human-JWT only. Phase 1 refactors it to dual-auth via
 * the `tasksApi.ts:34-36` pattern so agents holding a `cm_agent_*` token can
 * open agent↔agent 1:1 rooms (the `commonly_dm_agent` MCP tool calls this).
 *
 * Exercises:
 *   - 401 when no auth header is present.
 *   - Human path (legacy): JWT user opens a room with an installed agent.
 *   - Agent path (new): runtime token holder opens a room with another agent.
 *   - 1:1 invariant: repeated calls return the same pod (idempotent upsert).
 *   - Self-DM rejected (would degenerate the 1:1).
 *   - Missing agentName → 400.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');

jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret-for-room';

jest.setTimeout(60_000);

describe('POST /api/agents/runtime/room — dual-auth (ADR-010 Phase 1)', () => {
  let app;
  let humanUser;
  let humanToken;
  let pod;
  let aliceToken;
  let bobToken;

  const installAndIssueToken = async (agentName) => {
    await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${humanToken}`)
      .send({ agentName, podId: pod._id.toString(), scopes: ['context:read'] });
    const res = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/${agentName}/runtime-tokens`)
      .set('Authorization', `Bearer ${humanToken}`)
      .send({ label: `${agentName} test token` });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cm_agent_/);
    return res.body.token;
  };

  const registerAgent = async (agentName, displayName) => {
    await AgentRegistry.create({
      agentName,
      displayName,
      description: `Test agent ${displayName}`,
      registry: 'commonly-official',
      verified: true,
      manifest: {
        name: agentName,
        version: '1.0.0',
        capabilities: [{ name: 'memory', description: 'memory' }],
        context: { required: ['context:read'] },
        runtime: { type: 'standalone', connection: 'rest' },
      },
      latestVersion: '1.0.0',
      versions: [{ version: '1.0.0', publishedAt: new Date() }],
    });
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    humanUser = await User.create({
      username: 'room-test-human',
      email: 'room-test@test.com',
      password: 'password123',
    });
    humanToken = jwt.sign({ id: humanUser._id.toString() }, JWT_SECRET);

    pod = await Pod.create({
      name: 'Room Test Pod',
      type: 'chat',
      createdBy: humanUser._id,
      members: [humanUser._id],
    });

    await registerAgent('alice', 'Alice');
    await registerAgent('bob', 'Bob');
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    await Pod.deleteMany({ type: 'agent-room' });
    await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });

    aliceToken = await installAndIssueToken('alice');
    bobToken = await installAndIssueToken('bob');
  });

  it('returns 401 with no auth header', async () => {
    const res = await request(app)
      .post('/api/agents/runtime/room')
      .send({ agentName: 'alice' });
    expect(res.status).toBe(401);
  });

  describe('Human path (JWT)', () => {
    it('opens a human↔agent room', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${humanToken}`)
        .send({ agentName: 'alice' });
      expect(res.status).toBe(200);
      expect(res.body.room).toBeDefined();
      expect(res.body.room.type).toBe('agent-room');
      expect(res.body.room.members).toHaveLength(2);
    });

    it('returns 400 when agentName is missing', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${humanToken}`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('Agent path (cm_agent_* runtime token)', () => {
    it('opens an agent↔agent room', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ agentName: 'bob' });
      expect(res.status).toBe(200);
      expect(res.body.room).toBeDefined();
      expect(res.body.room.type).toBe('agent-room');
      expect(res.body.room.members).toHaveLength(2);
    });

    it('is idempotent — repeat call returns the same pod', async () => {
      const first = await request(app)
        .post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ agentName: 'bob' });
      const second = await request(app)
        .post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ agentName: 'bob' });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(String(first.body.room._id)).toBe(String(second.body.room._id));
      const allRooms = await Pod.find({ type: 'agent-room' });
      expect(allRooms).toHaveLength(1);
    });

    it('opens the same room regardless of which side initiates', async () => {
      const fromAlice = await request(app)
        .post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ agentName: 'bob' });
      const fromBob = await request(app)
        .post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ agentName: 'alice' });
      expect(fromAlice.status).toBe(200);
      expect(fromBob.status).toBe(200);
      expect(String(fromAlice.body.room._id)).toBe(String(fromBob.body.room._id));
    });

    it('returns 400 on self-DM', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ agentName: 'alice' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/yourself/i);
    });

    it('returns 400 when agentName is missing', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/room')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({});
      expect(res.status).toBe(400);
    });
  });
});
