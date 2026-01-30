/**
 * Two-Way Integration E2E Tests
 *
 * Tests the complete bidirectional flow between external platforms (Discord, GroupMe)
 * and Commonly pods:
 *
 * INBOUND: External Platform → Commonly
 *   1. External service posts to /api/integrations/ingest
 *   2. Messages buffered in integration.config.messageBuffer
 *   3. Scheduler summarizes buffered messages
 *   4. Agent event created for commonly-bot
 *   5. Commonly-bot posts summary to pod
 *
 * OUTBOUND: Commonly → External Platform
 *   1. Pod has activity/summaries
 *   2. External platform requests summary (e.g., !summary command)
 *   3. Summary sent back via webhook (Discord) or bot API (GroupMe)
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

// Models
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Message = require('../../models/Message');
const Summary = require('../../models/Summary');
const Integration = require('../../models/Integration');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentEvent = require('../../models/AgentEvent');
const AgentProfile = require('../../models/AgentProfile');
const DiscordIntegration = require('../../models/DiscordIntegration');

// Services
const AgentEventService = require('../../services/agentEventService');
const AgentMessageService = require('../../services/agentMessageService');
const IntegrationSummaryService = require('../../services/integrationSummaryService');
const schedulerService = require('../../services/schedulerService');

// SchedulerService is exported as an instance, static methods are on constructor
const SchedulerService = schedulerService.constructor;

// Routes
const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');
const integrationsRoutes = require('../../routes/integrations');

const JWT_SECRET = 'test-jwt-secret-for-two-way-e2e';

// Increase timeout for all tests
jest.setTimeout(60000);

// Mock summarizer to avoid Gemini API calls
jest.mock('../../services/summarizerService', () => ({
  generateSummary: jest.fn().mockResolvedValue('AI-generated summary of the conversation.'),
  summarizePosts: jest.fn().mockResolvedValue({ title: 'Posts Summary', content: 'Summary content' }),
  summarizeChats: jest.fn().mockResolvedValue({ title: 'Chats Summary', content: 'Summary content' }),
  constructor: {
    garbageCollectForDigest: jest.fn().mockResolvedValue(undefined),
    cleanOldSummaries: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock chatSummarizerService
jest.mock('../../services/chatSummarizerService', () => ({
  summarizeAllActiveChats: jest.fn().mockResolvedValue([]),
}));

// Mock PodAssetService
jest.mock('../../services/podAssetService', () => ({
  createIntegrationSummaryAsset: jest.fn().mockResolvedValue({}),
}));

// Mock axios for external API calls (GroupMe bot API)
jest.mock('axios');
const axios = require('axios');

// Mock global fetch for Discord webhook calls
global.fetch = jest.fn();

// Mock socket.io
jest.mock('../../config/socket', () => ({
  getIO: () => ({
    to: () => ({
      emit: jest.fn(),
    }),
  }),
}));

// Import hash utility for token verification
const { hash, randomSecret } = require('../../utils/secret');

describe('Two-Way Integration E2E Tests', () => {
  let app;
  let testUser;
  let authToken;
  let testPod;
  let commonlyBotAgent;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    // Create Express app with routes
    app = express();
    app.use(express.json());

    // Mock auth middleware
    app.use((req, res, next) => {
      const token = req.header('Authorization')?.replace('Bearer ', '');
      if (token && !token.startsWith('cm_')) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          req.user = { id: decoded.id };
        } catch (err) {
          // Token invalid - continue without user
        }
      }
      next();
    });

    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);
    app.use('/api/integrations', integrationsRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();
    axios.post.mockReset();
    axios.get.mockReset();
    global.fetch.mockReset();

    // Create test user
    testUser = await User.create({
      username: 'integration-tester',
      email: 'integration@test.com',
      password: 'hashedpassword123',
      role: 'admin',
    });
    authToken = jwt.sign({ id: testUser._id }, JWT_SECRET);

    // Create test pod
    testPod = await Pod.create({
      name: 'Two-Way Integration Test Pod',
      description: 'Testing bidirectional integration flow',
      type: 'chat',
      createdBy: testUser._id,
      members: [testUser._id],
    });

    // Register commonly-bot agent
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

  afterEach(async () => {
    await AgentInstallation.deleteMany({});
    await AgentEvent.deleteMany({});
    await AgentProfile.deleteMany({});
    await Integration.deleteMany({});
    await DiscordIntegration.deleteMany({});
    await Message.deleteMany({});
    await Summary.deleteMany({});
    await User.deleteMany({});
    await Pod.deleteMany({});
    await AgentRegistry.deleteMany({});
  });

  // Helper to create ingest token for integration
  const createIngestToken = async (integrationId) => {
    const token = `cm_int_${randomSecret(16)}`;
    const tokenHash = hash(token);

    await Integration.findByIdAndUpdate(integrationId, {
      $push: {
        ingestTokens: {
          tokenHash,
          label: 'Test Token',
          createdBy: testUser._id,
          createdAt: new Date(),
        },
      },
    });

    return token;
  };

  // Helper to create Discord integration with all required fields
  const createDiscordIntegration = async (integrationId, overrides = {}) => {
    const defaults = {
      integrationId,
      serverId: 'discord-server-test',
      serverName: 'Test Server',
      channelId: 'discord-channel-test',
      channelName: 'test-channel',
      webhookUrl: 'https://discord.com/api/webhooks/123456/abcdef',
      webhookId: '123456',
      botToken: 'test-bot-token-12345',
      isActive: true,
    };
    return DiscordIntegration.create({ ...defaults, ...overrides });
  };

  describe('1. Inbound Flow: External Platform → Commonly Pod', () => {
    describe('GroupMe → Commonly', () => {
      test('should ingest GroupMe messages via /api/integrations/ingest', async () => {
        // Create GroupMe integration
        const integration = await Integration.create({
          podId: testPod._id,
          type: 'groupme',
          status: 'connected',
          config: {
            groupId: 'test-group-123',
            groupName: 'Test GroupMe Group',
            botId: 'test-bot-456',
            messageBuffer: [],
          },
          createdBy: testUser._id,
          isActive: true,
        });

        // Create ingest token
        const ingestToken = await createIngestToken(integration._id);

        // Simulate GroupMe webhook event
        const groupmeEvent = {
          id: 'msg-001',
          group_id: 'test-group-123',
          user_id: 'user-alice',
          name: 'Alice',
          text: 'Hey team, what time is the standup?',
          created_at: Math.floor(Date.now() / 1000),
          sender_type: 'user',
        };

        const res = await request(app)
          .post('/api/integrations/ingest')
          .set('Authorization', `Bearer ${ingestToken}`)
          .send({
            provider: 'groupme',
            integrationId: integration._id.toString(),
            event: groupmeEvent,
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.count).toBe(1);

        // Verify message was buffered
        const updatedIntegration = await Integration.findById(integration._id);
        expect(updatedIntegration.config.messageBuffer.length).toBe(1);
        expect(updatedIntegration.config.messageBuffer[0].content).toBe('Hey team, what time is the standup?');
        expect(updatedIntegration.config.messageBuffer[0].authorName).toBe('Alice');
      });

      test('should ingest multiple GroupMe messages in sequence', async () => {
        const integration = await Integration.create({
          podId: testPod._id,
          type: 'groupme',
          status: 'connected',
          config: {
            groupId: 'group-multi',
            groupName: 'Multi Message Group',
            botId: 'bot-multi',
            messageBuffer: [],
          },
          createdBy: testUser._id,
          isActive: true,
        });

        const ingestToken = await createIngestToken(integration._id);

        // Send multiple messages
        const messages = [
          { id: 'msg-1', user_id: 'alice', name: 'Alice', text: 'Good morning!', created_at: Math.floor(Date.now() / 1000) - 60, sender_type: 'user' },
          { id: 'msg-2', user_id: 'bob', name: 'Bob', text: 'Morning! Ready for standup?', created_at: Math.floor(Date.now() / 1000) - 30, sender_type: 'user' },
          { id: 'msg-3', user_id: 'charlie', name: 'Charlie', text: 'Let me grab coffee first', created_at: Math.floor(Date.now() / 1000), sender_type: 'user' },
        ];

        for (const msg of messages) {
          await request(app)
            .post('/api/integrations/ingest')
            .set('Authorization', `Bearer ${ingestToken}`)
            .send({
              provider: 'groupme',
              integrationId: integration._id.toString(),
              event: msg,
            });
        }

        const updated = await Integration.findById(integration._id);
        expect(updated.config.messageBuffer.length).toBe(3);
        expect(updated.config.messageBuffer[0].authorName).toBe('Alice');
        expect(updated.config.messageBuffer[2].authorName).toBe('Charlie');
      });

      test('should skip bot messages to avoid loops', async () => {
        const integration = await Integration.create({
          podId: testPod._id,
          type: 'groupme',
          status: 'connected',
          config: {
            groupId: 'group-bot-skip',
            groupName: 'Bot Skip Group',
            botId: 'bot-skip',
            messageBuffer: [],
          },
          createdBy: testUser._id,
          isActive: true,
        });

        const ingestToken = await createIngestToken(integration._id);

        // Bot message should be skipped
        const botEvent = {
          id: 'msg-bot',
          group_id: 'group-bot-skip',
          user_id: 'bot-user',
          name: 'CommonlyBot',
          text: 'Summary posted!',
          created_at: Math.floor(Date.now() / 1000),
          sender_type: 'bot',
        };

        const res = await request(app)
          .post('/api/integrations/ingest')
          .set('Authorization', `Bearer ${ingestToken}`)
          .send({
            provider: 'groupme',
            integrationId: integration._id.toString(),
            event: botEvent,
          });

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0);

        const updated = await Integration.findById(integration._id);
        expect(updated.config.messageBuffer.length).toBe(0);
      });
    });

    describe('Discord → Commonly (via external service)', () => {
      test('should ingest Discord messages via /api/integrations/ingest with pre-normalized array', async () => {
        const integration = await Integration.create({
          podId: testPod._id,
          type: 'discord',
          status: 'connected',
          config: {
            serverId: 'discord-server-ingest',
            channelId: 'discord-channel-ingest',
            webhookListenerEnabled: true,
            messageBuffer: [],
          },
          createdBy: testUser._id,
          isActive: true,
        });

        await createDiscordIntegration(integration._id, {
          serverId: 'discord-server-ingest',
          channelId: 'discord-channel-ingest',
        });

        const ingestToken = await createIngestToken(integration._id);

        // External Discord service sends pre-normalized messages
        const normalizedMessages = [
          {
            source: 'discord',
            externalId: 'discord-msg-001',
            authorId: 'user-discord-1',
            authorName: 'DiscordUser1',
            content: 'Discussing the new feature implementation',
            timestamp: new Date().toISOString(),
          },
          {
            source: 'discord',
            externalId: 'discord-msg-002',
            authorId: 'user-discord-2',
            authorName: 'DiscordUser2',
            content: 'I think we should use TypeScript for this',
            timestamp: new Date().toISOString(),
          },
        ];

        const res = await request(app)
          .post('/api/integrations/ingest')
          .set('Authorization', `Bearer ${ingestToken}`)
          .send({
            provider: 'discord',
            integrationId: integration._id.toString(),
            messages: normalizedMessages,
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.count).toBe(2);

        const updated = await Integration.findById(integration._id);
        expect(updated.config.messageBuffer.length).toBe(2);
        expect(updated.config.messageBuffer[0].content).toBe('Discussing the new feature implementation');
      });
    });
  });

  describe('2. Scheduler Summarizes Buffered Messages', () => {
    test('should summarize GroupMe buffer and create agent event for commonly-bot', async () => {
      // Install commonly-bot on the pod
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      // Create integration with buffered messages
      const integration = await Integration.create({
        podId: testPod._id,
        type: 'groupme',
        status: 'connected',
        config: {
          groupId: 'summary-test-group',
          groupName: 'Summary Test Group',
          botId: 'summary-bot',
          messageBuffer: [
            {
              messageId: 'gm-1',
              authorId: 'user-1',
              authorName: 'Alice',
              content: 'Sprint planning starts at 10am',
              timestamp: new Date(Date.now() - 3600000),
            },
            {
              messageId: 'gm-2',
              authorId: 'user-2',
              authorName: 'Bob',
              content: 'Got it, I will prepare the backlog',
              timestamp: new Date(Date.now() - 1800000),
            },
            {
              messageId: 'gm-3',
              authorId: 'user-3',
              authorName: 'Charlie',
              content: 'Should we include the bug fixes in this sprint?',
              timestamp: new Date(Date.now() - 900000),
            },
          ],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      // Trigger scheduler summarization
      await SchedulerService.summarizeIntegrationBuffers();

      // Verify agent event was created
      const events = await AgentEvent.find({
        agentName: 'commonly-bot',
        podId: testPod._id,
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('integration.summary');
      expect(events[0].payload.source).toBe('groupme');
      expect(events[0].payload.summary.messageCount).toBe(3);

      // Verify buffer was cleared
      const updated = await Integration.findById(integration._id);
      expect(updated.config.messageBuffer.length).toBe(0);
    });

    test('should summarize Discord buffer and create agent event', async () => {
      // Install commonly-bot
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      const integration = await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          serverId: 'discord-summarize',
          channelId: 'channel-summarize',
          webhookListenerEnabled: true,
          messageBuffer: [
            {
              messageId: 'dc-1',
              authorId: 'discord-user-1',
              authorName: 'Dev1',
              content: 'PR review requested for the auth feature',
              timestamp: new Date(Date.now() - 3600000),
            },
            {
              messageId: 'dc-2',
              authorId: 'discord-user-2',
              authorName: 'Dev2',
              content: 'LGTM, approved!',
              timestamp: new Date(Date.now() - 1800000),
            },
          ],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      await createDiscordIntegration(integration._id, {
        serverId: 'discord-summarize',
        channelId: 'channel-summarize',
      });

      await SchedulerService.summarizeIntegrationBuffers();

      const events = await AgentEvent.find({
        agentName: 'commonly-bot',
        podId: testPod._id,
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('discord.summary'); // Discord uses discord.summary
      expect(events[0].payload.source).toBe('discord');
      expect(events[0].payload.summary.messageCount).toBe(2);
    });
  });

  describe('3. Commonly-Bot Posts Summary to Pod', () => {
    test('should post summary message to pod via agent runtime API', async () => {
      // Install commonly-bot and get runtime token
      const installRes = await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Test Token' });

      const runtimeToken = tokenRes.body.token;

      // Post summary to pod using runtime API
      const summaryContent = `📊 **GroupMe Summary**\n\nThe team discussed sprint planning. Alice announced the 10am meeting, Bob prepared the backlog, and Charlie asked about bug fixes.`;

      const postRes = await request(app)
        .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          content: summaryContent,
          messageType: 'text', // Valid enum values are: text, image
          metadata: {
            source: 'groupme',
            messageCount: 3,
          },
        });

      expect(postRes.status).toBe(200);
      expect(postRes.body.success).toBe(true);
      expect(postRes.body.message.content).toContain('GroupMe Summary');
    });
  });

  describe('4. Outbound Flow: Commonly → External Platform', () => {
    describe('Commonly → GroupMe', () => {
      test('should send summary to GroupMe via bot API', async () => {
        const groupmeService = require('../../services/groupmeService');

        // Mock successful GroupMe API response
        axios.post.mockResolvedValue({ status: 202, data: {} });

        const summaryText = 'The team discussed project milestones and Q2 deliverables.';
        const result = await groupmeService.sendMessage('bot-outbound-123', summaryText);

        expect(result.success).toBe(true);
        expect(axios.post).toHaveBeenCalledWith(
          'https://api.groupme.com/v3/bots/post',
          {
            bot_id: 'bot-outbound-123',
            text: summaryText,
          },
        );
      });

      test('should send pod summary to GroupMe when requested', async () => {
        const groupmeService = require('../../services/groupmeService');

        // Create a pod summary
        await Summary.create({
          type: 'chats',
          podId: testPod._id,
          title: 'Daily Pod Summary',
          content: 'Active discussions about feature development and bug triage.',
          timeRange: {
            start: new Date(Date.now() - 86400000),
            end: new Date(),
          },
          metadata: {
            totalItems: 25,
            podName: testPod.name,
          },
        });

        axios.post.mockResolvedValue({ status: 202, data: {} });

        // Fetch and send pod summary
        const latestSummary = await Summary.findOne({ podId: testPod._id }).sort({ createdAt: -1 });
        const result = await groupmeService.sendMessage('pod-summary-bot', latestSummary.content);

        expect(result.success).toBe(true);
        expect(axios.post).toHaveBeenCalledWith(
          'https://api.groupme.com/v3/bots/post',
          expect.objectContaining({
            text: expect.stringContaining('feature development'),
          }),
        );
      });
    });

    describe('Commonly → Discord', () => {
      test('should send summary to Discord via webhook', async () => {
        const DiscordService = require('../../services/discordService');

        // Create Discord integration
        const integration = await Integration.create({
          podId: testPod._id,
          type: 'discord',
          status: 'connected',
          config: {
            serverId: 'outbound-server',
            channelId: 'outbound-channel',
            webhookListenerEnabled: true,
          },
          createdBy: testUser._id,
          isActive: true,
        });

        await createDiscordIntegration(integration._id, {
          serverId: 'outbound-server',
          channelId: 'outbound-channel',
          webhookUrl: 'https://discord.com/api/webhooks/outbound/token',
        });

        // Mock successful webhook response
        global.fetch.mockResolvedValue({
          ok: true,
          status: 204,
        });

        const discordService = new DiscordService(integration._id);
        await discordService.initialize();

        const result = await discordService.sendMessage('📊 Pod activity summary: Team discussed Q2 roadmap.');

        expect(result).toBe(true);
        expect(global.fetch).toHaveBeenCalledWith(
          'https://discord.com/api/webhooks/outbound/token',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('Pod activity summary'),
          }),
        );
      });
    });
  });

  describe('5. Full Round-Trip Flow', () => {
    test('should complete full GroupMe → Commonly → GroupMe flow', async () => {
      const groupmeService = require('../../services/groupmeService');

      // 1. Install commonly-bot
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      // 2. Create GroupMe integration
      const integration = await Integration.create({
        podId: testPod._id,
        type: 'groupme',
        status: 'connected',
        config: {
          groupId: 'roundtrip-group',
          groupName: 'Round Trip Test',
          botId: 'roundtrip-bot',
          messageBuffer: [],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      const ingestToken = await createIngestToken(integration._id);

      // 3. INBOUND: GroupMe messages arrive
      const messages = [
        { id: '1', user_id: 'u1', name: 'Alice', text: 'Meeting at 3pm today', created_at: Math.floor(Date.now() / 1000) - 60, sender_type: 'user' },
        { id: '2', user_id: 'u2', name: 'Bob', text: 'Works for me!', created_at: Math.floor(Date.now() / 1000) - 30, sender_type: 'user' },
        { id: '3', user_id: 'u3', name: 'Charlie', text: 'I will join remotely', created_at: Math.floor(Date.now() / 1000), sender_type: 'user' },
      ];

      for (const msg of messages) {
        await request(app)
          .post('/api/integrations/ingest')
          .set('Authorization', `Bearer ${ingestToken}`)
          .send({
            provider: 'groupme',
            integrationId: integration._id.toString(),
            event: msg,
          });
      }

      // Verify messages buffered
      let updated = await Integration.findById(integration._id);
      expect(updated.config.messageBuffer.length).toBe(3);

      // 4. Scheduler summarizes buffer
      await SchedulerService.summarizeIntegrationBuffers();

      // 5. Verify agent event created
      const events = await AgentEvent.find({ agentName: 'commonly-bot' });
      expect(events.length).toBe(1);
      expect(events[0].payload.summary.messageCount).toBe(3);

      // 6. Get runtime token for commonly-bot
      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Test Token' });

      const runtimeToken = tokenRes.body.token;

      // 7. Commonly-bot posts summary to pod
      const summaryContent = `📊 **GroupMe Update**\n\n${events[0].payload.summary.content || 'Team scheduled a 3pm meeting with remote attendance.'}`;

      const postRes = await request(app)
        .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          content: summaryContent,
          messageType: 'text',
        });

      expect(postRes.status).toBe(200);

      // 8. Acknowledge the event
      const ackRes = await request(app)
        .post(`/api/agents/runtime/events/${events[0]._id}/ack`)
        .set('Authorization', `Bearer ${runtimeToken}`);

      expect(ackRes.status).toBe(200);

      // 9. OUTBOUND: Send acknowledgment back to GroupMe
      axios.post.mockResolvedValue({ status: 202, data: {} });

      const outboundResult = await groupmeService.sendMessage(
        integration.config.botId,
        '✅ Summary posted to Commonly pod!',
      );

      expect(outboundResult.success).toBe(true);
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.groupme.com/v3/bots/post',
        expect.objectContaining({
          bot_id: 'roundtrip-bot',
          text: '✅ Summary posted to Commonly pod!',
        }),
      );

      // 10. Verify buffer was cleared
      updated = await Integration.findById(integration._id);
      expect(updated.config.messageBuffer.length).toBe(0);
    });

    test('should complete full Discord → Commonly → Discord flow', async () => {
      const DiscordService = require('../../services/discordService');

      // 1. Install commonly-bot
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'messages:write'],
        });

      // 2. Create Discord integration
      const integration = await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          serverId: 'roundtrip-discord-server',
          channelId: 'roundtrip-discord-channel',
          webhookListenerEnabled: true,
          messageBuffer: [],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      await createDiscordIntegration(integration._id, {
        serverId: 'roundtrip-discord-server',
        channelId: 'roundtrip-discord-channel',
        webhookUrl: 'https://discord.com/api/webhooks/roundtrip/token',
      });

      const ingestToken = await createIngestToken(integration._id);

      // 3. INBOUND: Discord messages arrive (pre-normalized from external service)
      const discordMessages = [
        { source: 'discord', externalId: 'd1', authorId: 'dc1', authorName: 'Dev1', content: 'PR ready for review', timestamp: new Date().toISOString() },
        { source: 'discord', externalId: 'd2', authorId: 'dc2', authorName: 'Dev2', content: 'Reviewing now', timestamp: new Date().toISOString() },
      ];

      await request(app)
        .post('/api/integrations/ingest')
        .set('Authorization', `Bearer ${ingestToken}`)
        .send({
          provider: 'discord',
          integrationId: integration._id.toString(),
          messages: discordMessages,
        });

      // Verify messages buffered
      let updated = await Integration.findById(integration._id);
      expect(updated.config.messageBuffer.length).toBe(2);

      // 4. Scheduler summarizes
      await SchedulerService.summarizeIntegrationBuffers();

      // 5. Verify event created
      const events = await AgentEvent.find({ agentName: 'commonly-bot' });
      expect(events.length).toBe(1);
      expect(events[0].payload.source).toBe('discord');

      // 6. Get runtime token
      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Test Token' });

      const runtimeToken = tokenRes.body.token;

      // 7. Post to pod
      const postRes = await request(app)
        .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          content: `📊 **Discord Update**\n\nPR review discussion between Dev1 and Dev2.`,
          messageType: 'text',
        });

      expect(postRes.status).toBe(200);

      // 8. OUTBOUND: Send summary back to Discord
      global.fetch.mockResolvedValue({ ok: true, status: 204 });

      const discordService = new DiscordService(integration._id);
      await discordService.initialize();

      const outboundResult = await discordService.sendMessage('✅ Summary posted to Commonly!');

      expect(outboundResult).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/roundtrip/token',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Summary posted to Commonly'),
        }),
      );

      // 9. Verify buffer cleared
      updated = await Integration.findById(integration._id);
      expect(updated.config.messageBuffer.length).toBe(0);
    });
  });

  describe('6. Error Handling', () => {
    test('should handle invalid ingest token', async () => {
      const res = await request(app)
        .post('/api/integrations/ingest')
        .set('Authorization', 'Bearer cm_int_invalid_token_12345')
        .send({
          provider: 'groupme',
          event: { text: 'test' },
        });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid integration token');
    });

    test('should handle provider mismatch', async () => {
      const integration = await Integration.create({
        podId: testPod._id,
        type: 'groupme',
        status: 'connected',
        config: {},
        createdBy: testUser._id,
        isActive: true,
      });

      const ingestToken = await createIngestToken(integration._id);

      const res = await request(app)
        .post('/api/integrations/ingest')
        .set('Authorization', `Bearer ${ingestToken}`)
        .send({
          provider: 'discord', // Mismatch!
          integrationId: integration._id.toString(),
          event: { text: 'test' },
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Provider does not match integration type');
    });

    test('should handle GroupMe API failure gracefully', async () => {
      const groupmeService = require('../../services/groupmeService');

      axios.post.mockRejectedValue(new Error('GroupMe API rate limited'));

      const result = await groupmeService.sendMessage('bot-123', 'Test message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('GroupMe API rate limited');
    });

    test('should handle Discord webhook failure gracefully', async () => {
      const DiscordService = require('../../services/discordService');

      const integration = await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          serverId: 'error-server',
          channelId: 'error-channel',
        },
        createdBy: testUser._id,
        isActive: true,
      });

      await createDiscordIntegration(integration._id, {
        serverId: 'error-server',
        channelId: 'error-channel',
        webhookUrl: 'https://discord.com/api/webhooks/error/token',
      });

      global.fetch.mockResolvedValue({ ok: false, status: 404 });

      const discordService = new DiscordService(integration._id);
      await discordService.initialize();

      await expect(discordService.sendMessage('Test')).rejects.toThrow('HTTP error');
    });
  });
});
