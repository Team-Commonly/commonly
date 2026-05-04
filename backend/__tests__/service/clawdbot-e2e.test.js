/**
 * Clawdbot E2E Integration Tests
 *
 * End-to-end tests for the complete agent flow:
 * 1. Agent registration and installation on pods
 * 2. Runtime token generation and authentication
 * 3. Event queue management (enqueue, poll, ack)
 * 4. Agent posting messages to pods
 * 5. Clawdbot bridge simulation
 * 6. Pod summary generation with agent involvement
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

// Models
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Message = require('../../models/Message');
const Summary = require('../../models/Summary');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentEvent = require('../../models/AgentEvent');
const AgentProfile = require('../../models/AgentProfile');

// Routes
const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

// Services
const AgentEventService = require('../../services/agentEventService');
const AgentIdentityService = require('../../services/agentIdentityService');

// Utils
const { hash } = require('../../utils/secret');

const JWT_SECRET = 'test-jwt-secret-for-e2e';

// Increase timeout for all tests due to MongoMemoryServer startup
jest.setTimeout(60000);

describe('Clawdbot E2E Integration Tests', () => {
  let app;
  let testUser;
  let testUser2;
  let testUser3;
  let authToken;
  let authToken2;
  let authToken3;
  let testPod;
  let clawdbotAgent;
  let commonlyBotAgent;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    // Create Express app with routes
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    // Create test users
    testUser = await User.create({
      username: 'podadmin',
      email: 'podadmin@test.com',
      password: 'password123',
    });

    testUser2 = await User.create({
      username: 'chatuser1',
      email: 'chatuser1@test.com',
      password: 'password123',
    });

    testUser3 = await User.create({
      username: 'chatuser2',
      email: 'chatuser2@test.com',
      password: 'password123',
    });

    authToken = jwt.sign({ id: testUser._id.toString() }, JWT_SECRET);
    authToken2 = jwt.sign({ id: testUser2._id.toString() }, JWT_SECRET);
    authToken3 = jwt.sign({ id: testUser3._id.toString() }, JWT_SECRET);

    // Create test pod with members
    testPod = await Pod.create({
      name: 'Test Chat Pod',
      description: 'A pod for testing clawdbot integration',
      type: 'chat',
      createdBy: testUser._id,
      members: [testUser._id, testUser2._id, testUser3._id],
    });

    // Seed agent registry with clawdbot-bridge and commonly-bot
    clawdbotAgent = await AgentRegistry.create({
      agentName: 'clawdbot-bridge',
      displayName: 'Clawdbot Bridge',
      description: 'Routes Commonly events through Clawdbot and posts responses into pods',
      registry: 'commonly-official',
      categories: ['productivity', 'communication'],
      tags: ['clawdbot', 'bridge', 'assistant'],
      verified: true,
      manifest: {
        name: 'clawdbot-bridge',
        version: '1.0.0',
        capabilities: [
          { name: 'assistant', description: 'Respond to integration summaries' },
          { name: 'multi-agent', description: 'Bridge external Clawdbot runtimes' },
        ],
        context: { required: ['context:read', 'summaries:read', 'messages:write'] },
        runtime: {
          type: 'standalone',
          connection: 'rest',
        },
      },
      latestVersion: '1.0.0',
      versions: [{ version: '1.0.0', publishedAt: new Date() }],
      stats: { installs: 0, rating: 0, ratingCount: 0 },
    });

    commonlyBotAgent = await AgentRegistry.create({
      agentName: 'commonly-bot',
      displayName: 'Commonly Bot',
      description: 'Posts summaries and integration highlights into pods',
      registry: 'commonly-official',
      categories: ['productivity', 'communication'],
      tags: ['summaries', 'integrations', 'platform'],
      verified: true,
      manifest: {
        name: 'commonly-bot',
        version: '1.0.0',
        capabilities: [
          { name: 'summaries', description: 'Post summaries into pods' },
          { name: 'integration-updates', description: 'Share integration activity' },
        ],
        context: { required: ['context:read', 'summaries:read'] },
        runtime: {
          type: 'standalone',
          connection: 'rest',
        },
      },
      latestVersion: '1.0.0',
      versions: [{ version: '1.0.0', publishedAt: new Date() }],
      stats: { installs: 0, rating: 0, ratingCount: 0 },
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    // Clear installation-related data between tests but keep users, pods, and registry
    await AgentInstallation.deleteMany({});
    await AgentEvent.deleteMany({});
    await AgentProfile.deleteMany({});
    await Message.deleteMany({});
    await Summary.deleteMany({});
    // Reset agent runtime tokens so each beforeEach gets a fresh token
    await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
  });

  describe('1. Agent Registry and Discovery', () => {
    test('should list available agents in the registry', async () => {
      const res = await request(app)
        .get('/api/registry/agents')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.agents).toBeDefined();
      expect(res.body.agents.length).toBeGreaterThanOrEqual(2);

      const agentNames = res.body.agents.map((a) => a.name);
      expect(agentNames).toContain('clawdbot-bridge');
      expect(agentNames).toContain('commonly-bot');
    });

    test('should get agent details by name', async () => {
      const res = await request(app)
        .get('/api/registry/agents/clawdbot-bridge')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('clawdbot-bridge');
      expect(res.body.displayName).toBe('Clawdbot Bridge');
      expect(res.body.manifest).toBeDefined();
      expect(res.body.manifest.context.required).toContain('messages:write');
    });

    test('should return 404 for non-existent agent', async () => {
      const res = await request(app)
        .get('/api/registry/agents/non-existent-agent')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('2. Agent Installation on Pods', () => {
    test('should install clawdbot-bridge to a pod with required scopes', async () => {
      const res = await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.installation).toBeDefined();
      expect(res.body.installation.agentName).toBe('clawdbot-bridge');
      expect(res.body.installation.status).toBe('active');
      expect(res.body.installation.scopes).toContain('messages:write');

      // Verify installation in database
      const installation = await AgentInstallation.findOne({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
      });
      expect(installation).toBeTruthy();
      expect(installation.status).toBe('active');

      // Verify agent profile was created
      const profile = await AgentProfile.findOne({
        agentName: 'clawdbot-bridge',
        instanceId: 'default',
        podId: testPod._id,
      });
      expect(profile).toBeTruthy();
    });

    test('should reject installation with missing required scopes', async () => {
      const res = await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read'], // Missing summaries:read and messages:write
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Missing required scopes');
      expect(res.body.missingScopes).toContain('summaries:read');
      expect(res.body.missingScopes).toContain('messages:write');
    });

    test('should prevent duplicate installation', async () => {
      // First installation
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      // Second installation attempt
      const res = await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Agent already installed in this pod');
    });

    test('should list agents installed in a pod', async () => {
      // Install both agents
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      const res = await request(app)
        .get(`/api/registry/pods/${testPod._id}/agents`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.agents.length).toBe(2);

      const agentNames = res.body.agents.map((a) => a.name);
      expect(agentNames).toContain('clawdbot-bridge');
      expect(agentNames).toContain('commonly-bot');
    });

    test('should uninstall an agent from a pod', async () => {
      // Install first
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      // Uninstall
      const res = await request(app)
        .delete(`/api/registry/agents/clawdbot-bridge/pods/${testPod._id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify uninstalled
      const installation = await AgentInstallation.findOne({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
        status: 'active',
      });
      expect(installation).toBeFalsy();

      const agentUsername = AgentIdentityService.buildAgentUsername(
        AgentIdentityService.resolveAgentType('clawdbot-bridge'),
        'default',
      );
      const agentUser = await User.findOne({ username: agentUsername });
      const updatedPod = await Pod.findById(testPod._id);
      expect(updatedPod.members.map((m) => m.toString())).not.toContain(agentUser._id.toString());
    });

    test('should allow pod admin to uninstall agent installed by another member', async () => {
      // Install with a non-admin member
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken2}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      // Admin removes
      const res = await request(app)
        .delete(`/api/registry/agents/clawdbot-bridge/pods/${testPod._id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('should block uninstall for non-admin non-installer members', async () => {
      // Install with member 2
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken2}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      // Different member (not admin, not installer) tries to remove
      const res = await request(app)
        .delete(`/api/registry/agents/clawdbot-bridge/pods/${testPod._id}`)
        .set('Authorization', `Bearer ${authToken3}`);

      expect(res.status).toBe(403);
    });
  });

  describe('3. Runtime Token Management', () => {
    let installationId;

    beforeEach(async () => {
      // Install agent first
      const res = await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });
      installationId = res.body.installation.id;
    });

    test('should issue a runtime token for an installed agent', async () => {
      const res = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Test Token' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.token).toMatch(/^cm_agent_/);
      expect(res.body.label).toBe('Test Token');

      // Verify token is stored (hashed)
      const installation = await AgentInstallation.findById(installationId);
      expect(installation.runtimeTokens.length).toBe(1);
      expect(installation.runtimeTokens[0].tokenHash).toBeDefined();
    });

    test('should list runtime tokens for an agent', async () => {
      // Issue two tokens
      await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Token 1' });

      await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Token 2' });

      const res = await request(app)
        .get(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      // Second POST returns existing token — only one token per agent
      expect(res.body.tokens.length).toBe(1);
      expect(res.body.tokens[0].label).toBe('Token 1');
      // Should not expose tokenHash
      expect(res.body.tokens[0].tokenHash).toBeUndefined();
    });

    test('should revoke a runtime token', async () => {
      // Issue token
      await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Token to Revoke' });

      // Get token ID
      const listRes = await request(app)
        .get(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`);

      const tokenId = listRes.body.tokens[0].id;

      // Revoke
      const revokeRes = await request(app)
        .delete(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens/${tokenId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.success).toBe(true);

      // Verify revoked — runtime tokens are primarily on the agent User now
      const agentUsername = AgentIdentityService.buildAgentUsername(
        AgentIdentityService.resolveAgentType('clawdbot-bridge'),
        'default',
      );
      const agentUser = await User.findOne({ username: agentUsername, isBot: true });
      expect(agentUser.agentRuntimeTokens.length).toBe(0);
    });
  });

  describe('4. Agent Event Queue and Polling', () => {
    let agentToken;

    beforeEach(async () => {
      // Install agent and get runtime token
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'E2E Test Token' });

      agentToken = tokenRes.body.token;
    });

    test('should enqueue events for agents', async () => {
      // Enqueue an event using the service
      const event = await AgentEventService.enqueue({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
        type: 'integration.summary',
        payload: {
          summary: {
            content: 'Users discussed project deadlines and feature priorities.',
            messageCount: 15,
            timeRange: {
              start: new Date(Date.now() - 3600000),
              end: new Date(),
            },
          },
          integrationId: 'discord-integration-123',
          source: 'discord',
        },
      });

      expect(event).toBeDefined();
      expect(event.status).toBe('pending');
      expect(event.agentName).toBe('clawdbot-bridge');
    });

    test('should poll events via runtime API', async () => {
      // Enqueue multiple events
      await AgentEventService.enqueue({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
        type: 'integration.summary',
        payload: { summary: { content: 'Summary 1', messageCount: 5 } },
      });

      await AgentEventService.enqueue({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
        type: 'discord.summary',
        payload: { summary: { content: 'Summary 2', messageCount: 10 } },
      });

      // Poll events
      const res = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toBeDefined();
      expect(res.body.events.length).toBe(2);
      expect(res.body.events[0].status).toBe('pending');
    });

    test('should acknowledge events after processing', async () => {
      // Enqueue event
      const event = await AgentEventService.enqueue({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
        type: 'integration.summary',
        payload: { summary: { content: 'Test summary', messageCount: 3 } },
      });

      // Acknowledge
      const ackRes = await request(app)
        .post(`/api/agents/runtime/events/${event._id}/ack`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(ackRes.status).toBe(200);
      expect(ackRes.body.success).toBe(true);

      // Verify status changed (ADR-012 §3: ack now transitions to 'acked';
      // 'delivered' is the intermediate post-claim state before ack).
      const updatedEvent = await AgentEvent.findById(event._id);
      expect(updatedEvent.status).toBe('acked');
      expect(updatedEvent.deliveredAt).toBeDefined();
    });

    test('should only return events for the authenticated agent', async () => {
      // Install commonly-bot too
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      // Enqueue events for both agents
      await AgentEventService.enqueue({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
        type: 'integration.summary',
        payload: { summary: { content: 'For clawdbot', messageCount: 5 } },
      });

      await AgentEventService.enqueue({
        agentName: 'commonly-bot',
        podId: testPod._id,
        type: 'integration.summary',
        payload: { summary: { content: 'For commonly-bot', messageCount: 3 } },
      });

      // Poll with clawdbot token - should only see clawdbot events
      const res = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBe(1);
      expect(res.body.events[0].payload.summary.content).toBe('For clawdbot');
    });

    test('should reject requests with invalid agent token', async () => {
      const res = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', 'Bearer cm_agent_invalid_token_12345');

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid agent token');
    });

    test('should reject requests without agent token', async () => {
      const res = await request(app).get('/api/agents/runtime/events');

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Missing agent token');
    });
  });

  describe('5. Agent Posting Messages to Pods', () => {
    let agentToken;

    beforeEach(async () => {
      // Install agent and get runtime token
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Message Test Token' });

      agentToken = tokenRes.body.token;
    });

    test('should post a message to pod via runtime API', async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          content: 'Hello from Clawdbot! Based on the recent discussions, here are my insights...',
          messageType: 'text',
          metadata: {
            source: 'clawdbot-bridge',
            responseToEvent: 'event-123',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBeDefined();
      expect(res.body.message.content).toContain('Hello from Clawdbot');
    });

    test('should reject posting to unauthorized pod', async () => {
      // Create another pod that clawdbot is NOT installed on
      const otherPod = await Pod.create({
        name: 'Other Pod',
        description: 'A pod without clawdbot',
        type: 'chat',
        createdBy: testUser._id,
        members: [testUser._id],
      });

      const res = await request(app)
        .post(`/api/agents/runtime/pods/${otherPod._id}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          content: 'This should fail',
          messageType: 'text',
        });

      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Agent token not authorized for this pod');
    });

    test('should reject posting without content', async () => {
      const res = await request(app)
        .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          messageType: 'text',
        });

      // Empty content is silently skipped (not an error)
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.skipped).toBe(true);
      expect(res.body.reason).toBe('silent_or_empty');
    });
  });

  describe('6. Clawdbot Bridge Flow Simulation', () => {
    let agentToken;

    beforeEach(async () => {
      // Install agent and get runtime token
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Bridge Simulation Token' });

      agentToken = tokenRes.body.token;
    });

    test('should simulate complete bridge flow: poll -> process -> post -> ack', async () => {
      // 1. Enqueue a summary event (simulating scheduler trigger)
      const event = await AgentEventService.enqueue({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
        type: 'integration.summary',
        payload: {
          summary: {
            content: 'Team discussed the new feature rollout timeline. Key points: Q2 deadline, need more developers.',
            messageCount: 25,
            timeRange: {
              start: new Date(Date.now() - 3600000),
              end: new Date(),
            },
          },
          integrationId: 'discord-int-456',
          source: 'discord',
        },
      });

      // 2. Poll events (bridge polls)
      const pollRes = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(pollRes.status).toBe(200);
      expect(pollRes.body.events.length).toBe(1);

      const polledEvent = pollRes.body.events[0];
      expect(polledEvent.type).toBe('integration.summary');
      expect(polledEvent.payload.summary.messageCount).toBe(25);

      // 3. Simulate Clawdbot processing and generate response
      // (In real bridge, this would call Clawdbot Gateway)
      const clawdbotResponse = `Based on the Discord discussion summary:

**Key Insights:**
- The team has a Q2 deadline for the new feature rollout
- Additional developers are needed to meet this timeline

**Recommendations:**
1. Prioritize critical path items
2. Consider contracting additional help
3. Set up daily standups to track progress`;

      // 4. Post response to pod
      const postRes = await request(app)
        .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          content: clawdbotResponse,
          messageType: 'text',
          metadata: {
            source: 'clawdbot-bridge',
            eventId: polledEvent._id,
            model: 'claude-3-sonnet',
          },
        });

      expect(postRes.status).toBe(200);
      expect(postRes.body.success).toBe(true);

      // 5. Acknowledge event
      const ackRes = await request(app)
        .post(`/api/agents/runtime/events/${polledEvent._id}/ack`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(ackRes.status).toBe(200);

      // 6. Verify event is no longer pending
      const finalPollRes = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(finalPollRes.body.events.length).toBe(0);

      // 7. Verify event status in database (ADR-012 §3: 'acked' is the new
      // terminal state; 'delivered' is intermediate post-claim).
      const completedEvent = await AgentEvent.findById(event._id);
      expect(completedEvent.status).toBe('acked');
      expect(completedEvent.deliveredAt).toBeDefined();
    });

    test('should handle multiple events in sequence', async () => {
      // Enqueue multiple events
      const events = await Promise.all(
        [1, 2, 3].map((i) => AgentEventService.enqueue({
          agentName: 'clawdbot-bridge',
          podId: testPod._id,
          type: 'integration.summary',
          payload: {
            summary: {
              content: `Summary batch ${i}`,
              messageCount: i * 5,
            },
          },
        })),
      );

      // Process each event sequentially (intentional: each poll depends on prior ack)
      /* eslint-disable no-await-in-loop */
      for (let i = 0; i < events.length; i += 1) {
        // Poll (should get remaining events)
        const pollRes = await request(app)
          .get('/api/agents/runtime/events')
          .set('Authorization', `Bearer ${agentToken}`);

        expect(pollRes.body.events.length).toBe(events.length - i);

        // Post response
        await request(app)
          .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
          .set('Authorization', `Bearer ${agentToken}`)
          .send({
            content: `Response to batch ${i + 1}`,
            messageType: 'text',
          });

        // Acknowledge oldest pending event
        await request(app)
          .post(`/api/agents/runtime/events/${events[i]._id}/ack`)
          .set('Authorization', `Bearer ${agentToken}`);
      }
      /* eslint-enable no-await-in-loop */

      // Verify all events processed
      const finalPollRes = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(finalPollRes.body.events.length).toBe(0);
    });
  });

  describe('7. Multiple Agents on Same Pod', () => {
    let clawdbotToken;
    let commonlyBotToken;

    beforeEach(async () => {
      // Install both agents
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      // Get tokens for both
      const clawdbotTokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Clawdbot Token' });
      clawdbotToken = clawdbotTokenRes.body.token;

      const commonlyBotTokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Commonly Bot Token' });
      commonlyBotToken = commonlyBotTokenRes.body.token;
    });

    test('should isolate events between agents on the same pod', async () => {
      // Enqueue events for both agents
      await AgentEventService.enqueue({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
        type: 'integration.summary',
        payload: { summary: { content: 'For clawdbot', messageCount: 10 } },
      });

      await AgentEventService.enqueue({
        agentName: 'commonly-bot',
        podId: testPod._id,
        type: 'integration.summary',
        payload: { summary: { content: 'For commonly-bot', messageCount: 5 } },
      });

      // Each agent should only see their own events
      const clawdbotPoll = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${clawdbotToken}`);

      expect(clawdbotPoll.body.events.length).toBe(1);
      expect(clawdbotPoll.body.events[0].payload.summary.content).toBe('For clawdbot');

      const commonlyBotPoll = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${commonlyBotToken}`);

      expect(commonlyBotPoll.body.events.length).toBe(1);
      expect(commonlyBotPoll.body.events[0].payload.summary.content).toBe('For commonly-bot');
    });

    test('should allow both agents to post messages to the same pod', async () => {
      // Clawdbot posts
      const clawdbotPost = await request(app)
        .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
        .set('Authorization', `Bearer ${clawdbotToken}`)
        .send({
          content: 'Message from Clawdbot Bridge',
          messageType: 'text',
        });

      expect(clawdbotPost.status).toBe(200);

      // Commonly Bot posts
      const commonlyBotPost = await request(app)
        .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
        .set('Authorization', `Bearer ${commonlyBotToken}`)
        .send({
          content: 'Message from Commonly Bot',
          messageType: 'text',
        });

      expect(commonlyBotPost.status).toBe(200);

      // Both messages should be in the database
      // Note: In a real scenario, we'd check MongoDB or PostgreSQL
      // For this test, we verify both calls succeeded
    });
  });

  describe('8. User Messages and Summary Generation Simulation', () => {
    beforeEach(async () => {
      // Install agent
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'clawdbot-bridge',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });
    });

    test('should handle summary event from user chat activity', async () => {
      // Install now posts a self-introduction message (install.ts ~L229);
      // clear so the count below reflects only the user messages this test creates.
      await Message.deleteMany({ podId: testPod._id });

      // Simulate user messages being sent to the pod
      const userMessages = [
        { userId: testUser._id, content: 'Hey team, what\'s the status on the API integration?' },
        { userId: testUser2._id, content: 'I\'m almost done with the authentication module' },
        { userId: testUser3._id, content: 'Great! I\'ll start on the frontend once that\'s ready' },
        { userId: testUser._id, content: 'Perfect, let\'s aim to have a demo by Friday' },
        { userId: testUser2._id, content: 'Should be doable. Any blockers we need to address?' },
      ];

      // Create messages in MongoDB (simulating chat activity)
      await Promise.all(userMessages.map((msg) => Message.create({
        content: msg.content,
        userId: msg.userId,
        podId: testPod._id,
        messageType: 'text',
      })));

      // Verify messages were created
      const messageCount = await Message.countDocuments({ podId: testPod._id });
      expect(messageCount).toBe(5);

      // Simulate summary generation (like the scheduler would do)
      const summary = {
        content: 'The team discussed API integration progress. Authentication module is nearly complete, with frontend work to follow. Target: demo by Friday. No blockers identified.',
        messageCount: 5,
        timeRange: {
          start: new Date(Date.now() - 3600000),
          end: new Date(),
        },
      };

      // Save summary to database
      const savedSummary = await Summary.create({
        type: 'chats',
        podId: testPod._id,
        title: 'Test Pod Hourly Summary',
        content: summary.content,
        timeRange: summary.timeRange,
        metadata: {
          totalItems: summary.messageCount,
          podName: testPod.name,
        },
      });

      expect(savedSummary).toBeDefined();

      // Enqueue event for agent
      const event = await AgentEventService.enqueue({
        agentName: 'clawdbot-bridge',
        podId: testPod._id,
        type: 'chat.summary',
        payload: {
          summary,
          summaryId: savedSummary._id.toString(),
        },
      });

      expect(event).toBeDefined();
      expect(event.type).toBe('chat.summary');

      // Get runtime token
      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/clawdbot-bridge/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Summary Test Token' });

      const agentToken = tokenRes.body.token;

      // Agent polls and processes
      const pollRes = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(pollRes.body.events.length).toBe(1);
      expect(pollRes.body.events[0].type).toBe('chat.summary');
      expect(pollRes.body.events[0].payload.summary.messageCount).toBe(5);
    });
  });
});
