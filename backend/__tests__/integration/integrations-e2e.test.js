/**
 * Integrations E2E Tests
 *
 * End-to-end tests for integration message flows:
 * 1. Commonly-bot installation and message posting
 * 2. Discord integration - message buffering → summarization → agent events
 * 3. GroupMe integration - webhook → buffering → commands → summary
 * 4. Scheduler integration sync - hourly job simulation
 * 5. Cross-integration summary generation
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

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
const IntegrationSummaryService = require('../../services/integrationSummaryService');
const schedulerService = require('../../services/schedulerService');

// SchedulerService is exported as an instance, static methods are on constructor
const SchedulerService = schedulerService.constructor;

// Routes
const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret-for-integrations-e2e';

// Increase timeout for all tests
jest.setTimeout(60000);

// Mock the summarizerService to avoid actual AI calls
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

// Mock axios for external API calls (GroupMe)
jest.mock('axios');
const axios = require('axios');

// Mock global fetch for Discord webhook calls
global.fetch = jest.fn();

describe('Integrations E2E Tests', () => {
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
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    // Create test user
    testUser = await User.create({
      username: 'integrationadmin',
      email: 'integrationadmin@test.com',
      password: 'password123',
    });

    authToken = jwt.sign({ id: testUser._id.toString() }, JWT_SECRET);

    // Create test pod
    testPod = await Pod.create({
      name: 'Integration Test Pod',
      description: 'A pod for testing integrations',
      type: 'chat',
      createdBy: testUser._id,
      members: [testUser._id],
    });

    // Seed commonly-bot agent
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
    // Clear data between tests
    await AgentInstallation.deleteMany({});
    await AgentEvent.deleteMany({});
    await AgentProfile.deleteMany({});
    await Integration.deleteMany({});
    await DiscordIntegration.deleteMany({});
    await Message.deleteMany({});
    await Summary.deleteMany({});
  });

  describe('1. Commonly-Bot Installation and Operations', () => {
    test('should install commonly-bot to a pod', async () => {
      const res = await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.installation.agentName).toBe('commonly-bot');
      expect(res.body.installation.status).toBe('active');
    });

    test('should issue runtime token for commonly-bot', async () => {
      // Install first
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      // Issue token
      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Integration Sync Token' });

      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body.token).toMatch(/^cm_agent_/);
    });

    test('should poll and acknowledge events for commonly-bot', async () => {
      // Install and get token
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Test Token' });

      const agentToken = tokenRes.body.token;

      // Enqueue an event
      await AgentEventService.enqueue({
        agentName: 'commonly-bot',
        podId: testPod._id,
        type: 'integration.summary',
        payload: {
          summary: { content: 'Test summary', messageCount: 5 },
          source: 'discord',
        },
      });

      // Poll events
      const pollRes = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(pollRes.status).toBe(200);
      expect(pollRes.body.events.length).toBe(1);
      expect(pollRes.body.events[0].type).toBe('integration.summary');

      // Acknowledge
      const ackRes = await request(app)
        .post(`/api/agents/runtime/events/${pollRes.body.events[0]._id}/ack`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(ackRes.status).toBe(200);

      // Verify acknowledged
      const finalPoll = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(finalPoll.body.events.length).toBe(0);
    });
  });

  describe('2. Discord Integration Message Flow', () => {
    let discordIntegration;

    beforeEach(async () => {
      // Create Discord integration with message buffer
      discordIntegration = await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          serverId: 'discord-server-123',
          serverName: 'Test Discord Server',
          channelId: 'discord-channel-456',
          channelName: 'general',
          webhookListenerEnabled: true,
          messageBuffer: [],
          maxBufferSize: 1000,
        },
        createdBy: testUser._id,
        isActive: true,
      });
    });

    test('should buffer Discord messages', async () => {
      const messages = [
        {
          messageId: 'discord-msg-1',
          authorId: 'user-1',
          authorName: 'Alice',
          content: 'Hey everyone, how is the project going?',
          timestamp: new Date(Date.now() - 3600000),
        },
        {
          messageId: 'discord-msg-2',
          authorId: 'user-2',
          authorName: 'Bob',
          content: 'Making good progress on the API!',
          timestamp: new Date(Date.now() - 3000000),
        },
        {
          messageId: 'discord-msg-3',
          authorId: 'user-3',
          authorName: 'Charlie',
          content: 'I finished the frontend components.',
          timestamp: new Date(Date.now() - 1800000),
        },
      ];

      // Add messages to buffer
      await Integration.findByIdAndUpdate(discordIntegration._id, {
        $push: {
          'config.messageBuffer': { $each: messages },
        },
      });

      // Verify buffer
      const updated = await Integration.findById(discordIntegration._id);
      expect(updated.config.messageBuffer.length).toBe(3);
      expect(updated.config.messageBuffer[0].authorName).toBe('Alice');
    });

    test('should create summary from buffered Discord messages', async () => {
      // Add messages to buffer
      const messages = [
        {
          messageId: 'msg-1',
          authorId: 'user-1',
          authorName: 'Developer1',
          content: 'The deployment is ready for testing.',
          timestamp: new Date(Date.now() - 1800000),
        },
        {
          messageId: 'msg-2',
          authorId: 'user-2',
          authorName: 'Developer2',
          content: 'Great! I will start the QA process.',
          timestamp: new Date(Date.now() - 1200000),
        },
        {
          messageId: 'msg-3',
          authorId: 'user-3',
          authorName: 'Manager',
          content: 'Keep me posted on the progress.',
          timestamp: new Date(Date.now() - 600000),
        },
      ];

      await Integration.findByIdAndUpdate(discordIntegration._id, {
        'config.messageBuffer': messages,
      });

      // Create summary using service
      const integration = await Integration.findById(discordIntegration._id).lean();
      const summary = await IntegrationSummaryService.createSummary(
        integration,
        integration.config.messageBuffer,
      );

      expect(summary).toBeDefined();
      expect(summary.messageCount).toBe(3);
      expect(summary.source).toBe('discord');
      expect(summary.sourceLabel).toBe('Discord');
      expect(summary.serverName).toBe('Test Discord Server');
      expect(summary.channelName).toBe('general');
      expect(summary.timeRange.start).toBeDefined();
      expect(summary.timeRange.end).toBeDefined();
    });

    test('should enqueue agent event when summarizing Discord buffer', async () => {
      // Install commonly-bot
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      // Add messages to buffer
      const messages = [
        {
          messageId: 'msg-1',
          authorId: 'user-1',
          authorName: 'TeamMember',
          content: 'Sprint planning is scheduled for tomorrow.',
          timestamp: new Date(),
        },
      ];

      await Integration.findByIdAndUpdate(discordIntegration._id, {
        'config.messageBuffer': messages,
      });

      // Trigger integration buffer summarization
      const results = await SchedulerService.summarizeIntegrationBuffers();

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
      expect(results[0].messageCount).toBe(1);

      // Verify agent event was created
      const events = await AgentEvent.find({
        agentName: 'commonly-bot',
        podId: testPod._id,
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('discord.summary');
      expect(events[0].payload.source).toBe('discord');
      expect(events[0].status).toBe('pending');

      // Verify buffer was cleared
      const updated = await Integration.findById(discordIntegration._id);
      expect(updated.config.messageBuffer.length).toBe(0);
    });

    test('should skip Discord integration when webhookListenerEnabled is false', async () => {
      // Disable webhook listener
      await Integration.findByIdAndUpdate(discordIntegration._id, {
        'config.webhookListenerEnabled': false,
        'config.messageBuffer': [
          {
            messageId: 'msg-1',
            authorId: 'user-1',
            authorName: 'User',
            content: 'This should be skipped',
            timestamp: new Date(),
          },
        ],
      });

      const results = await SchedulerService.summarizeIntegrationBuffers();

      expect(results.length).toBe(1);
      expect(results[0].skipped).toBe(true);
      expect(results[0].reason).toBe('Auto sync disabled');

      // Verify no agent event created
      const events = await AgentEvent.find({ podId: testPod._id });
      expect(events.length).toBe(0);
    });
  });

  describe('3. GroupMe Integration Message Flow', () => {
    let groupmeIntegration;

    beforeEach(async () => {
      // Create GroupMe integration
      groupmeIntegration = await Integration.create({
        podId: testPod._id,
        type: 'groupme',
        status: 'connected',
        config: {
          groupId: 'groupme-group-123',
          groupName: 'Test GroupMe Group',
          botId: 'bot-456',
          messageBuffer: [],
          maxBufferSize: 1000,
        },
        createdBy: testUser._id,
        isActive: true,
      });
    });

    test('should buffer GroupMe messages', async () => {
      const messages = [
        {
          messageId: 'gm-msg-1',
          authorId: 'gm-user-1',
          authorName: 'GroupMember1',
          content: 'Hello from GroupMe!',
          timestamp: new Date(Date.now() - 3600000),
        },
        {
          messageId: 'gm-msg-2',
          authorId: 'gm-user-2',
          authorName: 'GroupMember2',
          content: 'Hey! How are you?',
          timestamp: new Date(Date.now() - 1800000),
        },
      ];

      await Integration.findByIdAndUpdate(groupmeIntegration._id, {
        $push: {
          'config.messageBuffer': { $each: messages },
        },
      });

      const updated = await Integration.findById(groupmeIntegration._id);
      expect(updated.config.messageBuffer.length).toBe(2);
    });

    test('should create summary from GroupMe buffer', async () => {
      const messages = [
        {
          messageId: 'gm-1',
          authorId: 'user-a',
          authorName: 'Alex',
          content: 'Meeting moved to 3pm',
          timestamp: new Date(Date.now() - 3600000),
        },
        {
          messageId: 'gm-2',
          authorId: 'user-b',
          authorName: 'Beth',
          content: 'Thanks for the update!',
          timestamp: new Date(Date.now() - 3000000),
        },
        {
          messageId: 'gm-3',
          authorId: 'user-c',
          authorName: 'Chris',
          content: 'I will be there.',
          timestamp: new Date(Date.now() - 1800000),
        },
      ];

      await Integration.findByIdAndUpdate(groupmeIntegration._id, {
        'config.messageBuffer': messages,
      });

      const integration = await Integration.findById(groupmeIntegration._id).lean();
      const summary = await IntegrationSummaryService.createSummary(
        integration,
        integration.config.messageBuffer,
      );

      expect(summary.messageCount).toBe(3);
      expect(summary.source).toBe('groupme');
      expect(summary.sourceLabel).toBe('GroupMe');
      expect(summary.channelName).toBe('Test GroupMe Group');
    });

    test('should enqueue integration.summary event for GroupMe', async () => {
      // Install commonly-bot
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      const messages = [
        {
          messageId: 'gm-msg',
          authorId: 'user-1',
          authorName: 'GroupUser',
          content: 'Lunch at noon?',
          timestamp: new Date(),
        },
      ];

      await Integration.findByIdAndUpdate(groupmeIntegration._id, {
        'config.messageBuffer': messages,
      });

      await SchedulerService.summarizeIntegrationBuffers();

      const events = await AgentEvent.find({
        agentName: 'commonly-bot',
        podId: testPod._id,
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('integration.summary'); // Not discord.summary
      expect(events[0].payload.source).toBe('groupme');
    });
  });

  describe('4. Multi-Integration Scheduler Sync', () => {
    test('should summarize multiple integration buffers in one run', async () => {
      // Install commonly-bot
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      // Create Discord integration
      const discordIntegration = await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          serverId: 'server-1',
          serverName: 'Discord Server',
          channelId: 'channel-1',
          channelName: 'dev-chat',
          webhookListenerEnabled: true,
          messageBuffer: [
            {
              messageId: 'd-1',
              authorId: 'du-1',
              authorName: 'DiscordUser',
              content: 'Discord message',
              timestamp: new Date(),
            },
          ],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      // Create GroupMe integration
      const groupmeIntegration = await Integration.create({
        podId: testPod._id,
        type: 'groupme',
        status: 'connected',
        config: {
          groupId: 'group-1',
          groupName: 'GroupMe Chat',
          botId: 'bot-1',
          messageBuffer: [
            {
              messageId: 'g-1',
              authorId: 'gu-1',
              authorName: 'GroupMeUser',
              content: 'GroupMe message',
              timestamp: new Date(),
            },
          ],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      // Create Slack integration
      const slackIntegration = await Integration.create({
        podId: testPod._id,
        type: 'slack',
        status: 'connected',
        config: {
          channelId: 'slack-channel-1',
          channelName: 'general',
          messageBuffer: [
            {
              messageId: 's-1',
              authorId: 'su-1',
              authorName: 'SlackUser',
              content: 'Slack message',
              timestamp: new Date(),
            },
          ],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      // Run scheduler
      const results = await SchedulerService.summarizeIntegrationBuffers();

      // Should process all three integrations
      const successResults = results.filter((r) => r.success && !r.skipped);
      expect(successResults.length).toBe(3);

      // Verify agent events
      const events = await AgentEvent.find({ agentName: 'commonly-bot' });
      expect(events.length).toBe(3);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('discord.summary');
      expect(eventTypes).toContain('integration.summary'); // GroupMe and Slack

      // Verify all buffers cleared
      const [d, g, s] = await Promise.all([
        Integration.findById(discordIntegration._id),
        Integration.findById(groupmeIntegration._id),
        Integration.findById(slackIntegration._id),
      ]);

      expect(d.config.messageBuffer.length).toBe(0);
      expect(g.config.messageBuffer.length).toBe(0);
      expect(s.config.messageBuffer.length).toBe(0);
    });

    test('should handle empty buffers gracefully', async () => {
      // Create integration with empty buffer
      await Integration.create({
        podId: testPod._id,
        type: 'telegram',
        status: 'connected',
        config: {
          chatId: 'tg-chat-1',
          chatTitle: 'Telegram Chat',
          messageBuffer: [],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      // This should not throw and return empty results
      const results = await SchedulerService.summarizeIntegrationBuffers();
      expect(results.length).toBe(0); // No integrations with messages
    });

    test('should process integrations even without commonly-bot installed', async () => {
      // Create Discord integration (no commonly-bot installed)
      await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          serverId: 'server-x',
          serverName: 'Server X',
          channelId: 'channel-x',
          channelName: 'chat',
          webhookListenerEnabled: true,
          messageBuffer: [
            {
              messageId: 'msg-x',
              authorId: 'user-x',
              authorName: 'User',
              content: 'Test message',
              timestamp: new Date(),
            },
          ],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      // Should still create events (agent will process when installed)
      const results = await SchedulerService.summarizeIntegrationBuffers();
      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);

      const events = await AgentEvent.find({ agentName: 'commonly-bot' });
      expect(events.length).toBe(1);
    });
  });

  describe('5. Complete Integration to Agent Flow', () => {
    test('should complete full flow: buffer → summarize → event → poll → ack', async () => {
      // 1. Install commonly-bot
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Full Flow Token' });

      const agentToken = tokenRes.body.token;

      // 2. Create integration with messages
      const integration = await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          serverId: 'full-flow-server',
          serverName: 'Full Flow Discord',
          channelId: 'full-flow-channel',
          channelName: 'discussions',
          webhookListenerEnabled: true,
          messageBuffer: [
            {
              messageId: 'ff-1',
              authorId: 'u1',
              authorName: 'Alice',
              content: 'The quarterly review is coming up.',
              timestamp: new Date(Date.now() - 3600000),
            },
            {
              messageId: 'ff-2',
              authorId: 'u2',
              authorName: 'Bob',
              content: 'I have prepared the slides.',
              timestamp: new Date(Date.now() - 3000000),
            },
            {
              messageId: 'ff-3',
              authorId: 'u3',
              authorName: 'Charlie',
              content: 'Let me know if you need any data.',
              timestamp: new Date(Date.now() - 1800000),
            },
          ],
        },
        createdBy: testUser._id,
        isActive: true,
      });

      // 3. Trigger scheduler summarization
      const results = await SchedulerService.summarizeIntegrationBuffers();
      expect(results[0].success).toBe(true);
      expect(results[0].messageCount).toBe(3);

      // 4. Poll events as commonly-bot
      const pollRes = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(pollRes.body.events.length).toBe(1);
      const event = pollRes.body.events[0];
      expect(event.type).toBe('discord.summary');
      expect(event.payload.summary.messageCount).toBe(3);
      expect(event.payload.summary.serverName).toBe('Full Flow Discord');
      expect(event.payload.summary.channelName).toBe('discussions');

      // 5. Acknowledge event
      await request(app)
        .post(`/api/agents/runtime/events/${event._id}/ack`)
        .set('Authorization', `Bearer ${agentToken}`);

      // 6. Verify event processed
      const processedEvent = await AgentEvent.findById(event._id);
      expect(processedEvent.status).toBe('delivered');

      // 7. Verify buffer cleared
      const updatedIntegration = await Integration.findById(integration._id);
      expect(updatedIntegration.config.messageBuffer.length).toBe(0);
      expect(updatedIntegration.config.lastSummaryAt).toBeDefined();
    });

    test('should handle high-volume message buffer', async () => {
      // Install commonly-bot
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      // Create integration with many messages
      const messages = [];
      for (let i = 0; i < 100; i++) {
        messages.push({
          messageId: `hv-msg-${i}`,
          authorId: `user-${i % 10}`,
          authorName: `User${i % 10}`,
          content: `Message number ${i} with some content.`,
          timestamp: new Date(Date.now() - (100 - i) * 60000),
        });
      }

      await Integration.create({
        podId: testPod._id,
        type: 'groupme',
        status: 'connected',
        config: {
          groupId: 'high-volume-group',
          groupName: 'High Volume Chat',
          botId: 'hv-bot',
          messageBuffer: messages,
        },
        createdBy: testUser._id,
        isActive: true,
      });

      const results = await SchedulerService.summarizeIntegrationBuffers();

      expect(results[0].success).toBe(true);
      expect(results[0].messageCount).toBe(100);

      const events = await AgentEvent.find({ agentName: 'commonly-bot' });
      expect(events.length).toBe(1);
      expect(events[0].payload.summary.messageCount).toBe(100);
    });
  });

  describe('6. Summary Content Generation', () => {
    test('should handle empty content messages', async () => {
      const messages = [
        {
          messageId: 'empty-1',
          authorId: 'user-1',
          authorName: 'User1',
          content: '',
          timestamp: new Date(),
          attachments: ['https://example.com/image.png'],
        },
        {
          messageId: 'empty-2',
          authorId: 'user-2',
          authorName: 'User2',
          content: '',
          timestamp: new Date(),
        },
      ];

      const integration = {
        type: 'discord',
        config: {
          serverName: 'Test',
          channelName: 'test-channel',
        },
      };

      const summary = await IntegrationSummaryService.createSummary(integration, messages);

      expect(summary.messageCount).toBe(2);
      // Empty messages should be handled gracefully
    });

    test('should generate direct content for 1-2 messages', async () => {
      const messages = [
        {
          messageId: 'single-1',
          authorId: 'user-1',
          authorName: 'Solo',
          content: 'Just a single message here.',
          timestamp: new Date(),
        },
      ];

      const integration = {
        type: 'groupme',
        config: {
          groupName: 'Small Group',
        },
      };

      const summary = await IntegrationSummaryService.createSummary(integration, messages);

      expect(summary.content).toContain('Solo');
      expect(summary.content).toContain('Just a single message here');
    });

    test('should use AI summarization for 3+ messages', async () => {
      const summarizerService = require('../../services/summarizerService');

      const messages = [
        { messageId: '1', authorId: 'u1', authorName: 'A', content: 'First', timestamp: new Date() },
        { messageId: '2', authorId: 'u2', authorName: 'B', content: 'Second', timestamp: new Date() },
        { messageId: '3', authorId: 'u3', authorName: 'C', content: 'Third', timestamp: new Date() },
      ];

      const integration = {
        type: 'slack',
        config: { channelName: 'general' },
      };

      await IntegrationSummaryService.createSummary(integration, messages);

      // Verify AI was called (mocked)
      expect(summarizerService.generateSummary).toHaveBeenCalled();
    });
  });

  describe('7. Integration Type Handling', () => {
    test.each([
      ['discord', 'discord.summary', 'Discord'],
      ['groupme', 'integration.summary', 'GroupMe'],
      ['slack', 'integration.summary', 'Slack'],
      ['telegram', 'integration.summary', 'Telegram'],
    ])('should handle %s integration correctly', async (type, expectedEventType, expectedLabel) => {
      // Install commonly-bot
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      const config = {
        messageBuffer: [
          {
            messageId: `${type}-msg`,
            authorId: 'user',
            authorName: 'TestUser',
            content: `Message from ${type}`,
            timestamp: new Date(),
          },
        ],
      };

      if (type === 'discord') {
        config.serverId = 'server';
        config.channelId = 'channel';
        config.webhookListenerEnabled = true;
      } else if (type === 'groupme') {
        config.groupId = 'group';
        config.groupName = 'GroupMe Group';
        config.botId = 'bot';
      } else if (type === 'slack') {
        config.channelId = 'slack-channel';
        config.channelName = 'slack-general';
      } else if (type === 'telegram') {
        config.chatId = 'tg-chat';
        config.chatTitle = 'TG Chat';
      }

      await Integration.create({
        podId: testPod._id,
        type,
        status: 'connected',
        config,
        createdBy: testUser._id,
        isActive: true,
      });

      await SchedulerService.summarizeIntegrationBuffers();

      const events = await AgentEvent.find({ podId: testPod._id });
      expect(events.length).toBe(1);
      expect(events[0].type).toBe(expectedEventType);
      expect(events[0].payload.summary.sourceLabel).toBe(expectedLabel);
    });
  });

  describe('8. Error Handling', () => {
    test('should handle integration without buffer gracefully', async () => {
      await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          serverId: 'server',
          channelId: 'channel',
          webhookListenerEnabled: true,
          // No messageBuffer field
        },
        createdBy: testUser._id,
        isActive: true,
      });

      // Should not throw
      const results = await SchedulerService.summarizeIntegrationBuffers();
      expect(results.length).toBe(0); // Empty buffer means no results
    });

    test('should handle inactive integrations', async () => {
      await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          serverId: 'server',
          channelId: 'channel',
          webhookListenerEnabled: true,
          messageBuffer: [
            { messageId: '1', authorId: 'u', authorName: 'U', content: 'Hi', timestamp: new Date() },
          ],
        },
        createdBy: testUser._id,
        isActive: false, // Inactive
      });

      const results = await SchedulerService.summarizeIntegrationBuffers();
      expect(results.length).toBe(0); // Inactive should be skipped
    });
  });

  describe('9. Outbound Messaging to External Platforms', () => {
    beforeEach(() => {
      // Reset mocks before each test
      jest.clearAllMocks();
      axios.post.mockReset();
      global.fetch.mockReset();
    });

    describe('GroupMe Outbound Messages', () => {
      const groupmeService = require('../../services/groupmeService');

      test('should send message to GroupMe via bot API', async () => {
        // Mock successful GroupMe API response
        axios.post.mockResolvedValueOnce({ status: 202, data: {} });

        const result = await groupmeService.sendMessage('bot-123', 'Hello from Commonly!');

        expect(result.success).toBe(true);
        expect(axios.post).toHaveBeenCalledWith(
          'https://api.groupme.com/v3/bots/post',
          {
            bot_id: 'bot-123',
            text: 'Hello from Commonly!',
          },
        );
      });

      test('should handle GroupMe API errors gracefully', async () => {
        axios.post.mockRejectedValueOnce(new Error('Network error'));

        const result = await groupmeService.sendMessage('bot-123', 'Test message');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Network error');
      });

      test('should reject messages without botId', async () => {
        const result = await groupmeService.sendMessage(null, 'Test message');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Missing botId or text');
        expect(axios.post).not.toHaveBeenCalled();
      });

      test('should reject messages without text', async () => {
        const result = await groupmeService.sendMessage('bot-123', '');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Missing botId or text');
        expect(axios.post).not.toHaveBeenCalled();
      });

      test('should send summary acknowledgment to GroupMe', async () => {
        axios.post.mockResolvedValueOnce({ status: 202, data: {} });

        // Simulate what happens when !summary command is processed
        const acknowledgment = '✅ Queued 5 message(s) for Commonly Bot.';
        const result = await groupmeService.sendMessage('groupme-bot-456', acknowledgment);

        expect(result.success).toBe(true);
        expect(axios.post).toHaveBeenCalledWith(
          'https://api.groupme.com/v3/bots/post',
          expect.objectContaining({
            bot_id: 'groupme-bot-456',
            text: expect.stringContaining('Queued'),
          }),
        );
      });
    });

    describe('Discord Webhook Outbound Messages', () => {
      const DiscordService = require('../../services/discordService');
      const DiscordIntegration = require('../../models/DiscordIntegration');

      // Helper to create full DiscordIntegration with all required fields
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

      test('should send message to Discord via webhook', async () => {
        // Create integration with platform integration
        const integration = await Integration.create({
          podId: testPod._id,
          type: 'discord',
          status: 'connected',
          config: {
            serverId: 'discord-server-outbound',
            serverName: 'Outbound Test Server',
            channelId: 'discord-channel-outbound',
            channelName: 'announcements',
            webhookListenerEnabled: true,
            messageBuffer: [],
          },
          createdBy: testUser._id,
          isActive: true,
        });

        // Create platform integration with all required fields
        await createDiscordIntegration(integration._id, {
          serverId: 'discord-server-outbound',
          serverName: 'Outbound Test Server',
          channelId: 'discord-channel-outbound',
          channelName: 'announcements',
          webhookUrl: 'https://discord.com/api/webhooks/123456/abcdef',
          webhookId: '123456',
        });

        // Mock successful Discord webhook response
        global.fetch.mockResolvedValueOnce({
          ok: true,
          status: 204,
        });

        const discordService = new DiscordService(integration._id);
        await discordService.initialize();

        const result = await discordService.sendMessage('Summary from Commonly Bot!');

        expect(result).toBe(true);
        expect(global.fetch).toHaveBeenCalledWith(
          'https://discord.com/api/webhooks/123456/abcdef',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: expect.stringContaining('Summary from Commonly Bot!'),
          }),
        );
      });

      test('should handle Discord webhook errors', async () => {
        const integration = await Integration.create({
          podId: testPod._id,
          type: 'discord',
          status: 'connected',
          config: {
            serverId: 'server-error',
            serverName: 'Error Server',
            channelId: 'channel-error',
            channelName: 'error-channel',
            webhookListenerEnabled: true,
          },
          createdBy: testUser._id,
          isActive: true,
        });

        await createDiscordIntegration(integration._id, {
          serverId: 'server-error',
          serverName: 'Error Server',
          channelId: 'channel-error',
          channelName: 'error-channel',
          webhookUrl: 'https://discord.com/api/webhooks/invalid/token',
          webhookId: 'invalid',
        });

        // Mock failed Discord webhook response
        global.fetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
        });

        const discordService = new DiscordService(integration._id);
        await discordService.initialize();

        await expect(discordService.sendMessage('Test')).rejects.toThrow('HTTP error');
      });

      test('should track outgoing message in history', async () => {
        const integration = await Integration.create({
          podId: testPod._id,
          type: 'discord',
          status: 'connected',
          config: {
            serverId: 'server-history',
            serverName: 'History Server',
            channelId: 'channel-history',
            channelName: 'history-channel',
            webhookListenerEnabled: true,
            messageBuffer: [],
          },
          createdBy: testUser._id,
          isActive: true,
        });

        await createDiscordIntegration(integration._id, {
          serverId: 'server-history',
          serverName: 'History Server',
          channelId: 'channel-history',
          channelName: 'history-channel',
          webhookUrl: 'https://discord.com/api/webhooks/history/token',
          webhookId: 'history',
        });

        // Mock successful Discord webhook response
        global.fetch.mockResolvedValueOnce({
          ok: true,
          status: 204,
        });

        const discordService = new DiscordService(integration._id);
        await discordService.initialize();

        await discordService.sendMessage('Tracked outbound message');

        // Verify the sendMessage method was called (webhook was used)
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('Full Outbound Flow Simulation', () => {
      const groupmeService = require('../../services/groupmeService');

      test('should simulate GroupMe command → summary → outbound message flow', async () => {
        // Install commonly-bot
        await request(app)
          .post('/api/registry/install')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            agentName: 'commonly-bot',
            podId: testPod._id.toString(),
            scopes: ['context:read', 'summaries:read'],
          });

        // Create GroupMe integration
        const integration = await Integration.create({
          podId: testPod._id,
          type: 'groupme',
          status: 'connected',
          config: {
            groupId: 'full-flow-group',
            groupName: 'Full Flow GroupMe',
            botId: 'outbound-bot-789',
            messageBuffer: [
              {
                messageId: 'gm-1',
                authorId: 'user-1',
                authorName: 'Alice',
                content: 'Planning meeting at 2pm',
                timestamp: new Date(Date.now() - 3600000),
              },
              {
                messageId: 'gm-2',
                authorId: 'user-2',
                authorName: 'Bob',
                content: 'I will be there!',
                timestamp: new Date(Date.now() - 1800000),
              },
            ],
          },
          createdBy: testUser._id,
          isActive: true,
        });

        // Mock GroupMe API for acknowledgment message
        axios.post.mockResolvedValue({ status: 202, data: {} });

        // 1. Trigger summarization (simulates scheduler)
        await SchedulerService.summarizeIntegrationBuffers();

        // 2. Verify agent event was created
        const events = await AgentEvent.find({
          agentName: 'commonly-bot',
          podId: testPod._id,
        });
        expect(events.length).toBe(1);
        expect(events[0].type).toBe('integration.summary');
        expect(events[0].payload.summary.messageCount).toBe(2);

        // 3. Simulate sending acknowledgment back to GroupMe
        const ackResult = await groupmeService.sendMessage(
          integration.config.botId,
          `✅ Queued ${events[0].payload.summary.messageCount} message(s) for Commonly Bot.`,
        );

        expect(ackResult.success).toBe(true);
        expect(axios.post).toHaveBeenCalledWith(
          'https://api.groupme.com/v3/bots/post',
          expect.objectContaining({
            bot_id: 'outbound-bot-789',
            text: '✅ Queued 2 message(s) for Commonly Bot.',
          }),
        );
      });

      test('should simulate fetching pod summary and sending to GroupMe', async () => {
        // Create a summary in the pod
        const summary = await Summary.create({
          type: 'chats',
          podId: testPod._id,
          title: 'Pod Chat Summary',
          content: 'The team discussed project milestones and Q2 deliverables.',
          timeRange: {
            start: new Date(Date.now() - 3600000),
            end: new Date(),
          },
          metadata: {
            totalItems: 15,
            podName: testPod.name,
          },
        });

        // Create GroupMe integration
        await Integration.create({
          podId: testPod._id,
          type: 'groupme',
          status: 'connected',
          config: {
            groupId: 'pod-summary-group',
            groupName: 'Pod Summary GroupMe',
            botId: 'summary-bot-101',
            messageBuffer: [],
          },
          createdBy: testUser._id,
          isActive: true,
        });

        // Mock GroupMe API
        axios.post.mockResolvedValue({ status: 202, data: {} });

        // Simulate !pod-summary command: fetch summary and send to GroupMe
        const latestSummary = await Summary.findOne({ podId: testPod._id }).sort({ createdAt: -1 });

        expect(latestSummary).toBeDefined();
        expect(latestSummary.content).toContain('project milestones');

        // Send summary to GroupMe (truncated if needed)
        const truncatedSummary = latestSummary.content.substring(0, 900);
        const result = await groupmeService.sendMessage('summary-bot-101', truncatedSummary);

        expect(result.success).toBe(true);
        expect(axios.post).toHaveBeenCalledWith(
          'https://api.groupme.com/v3/bots/post',
          expect.objectContaining({
            bot_id: 'summary-bot-101',
            text: expect.stringContaining('project milestones'),
          }),
        );
      });
    });

  describe('6. Agent Runtime Integration Access Endpoints', () => {
    beforeEach(() => {
      axios.get.mockReset();
    });

    test('should list agent-accessible integrations with integration:read scope', async () => {
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'integration:read'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Integration Access Token' });

      await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          channelId: 'discord-channel-123',
          channelName: 'general',
          botToken: 'discord-bot-token',
          agentAccessEnabled: true,
        },
        createdBy: testUser._id,
        isActive: true,
      });

      await Integration.create({
        podId: testPod._id,
        type: 'groupme',
        status: 'connected',
        config: {
          groupId: 'groupme-group-456',
          groupName: 'GroupMe Test',
          accessToken: 'groupme-access-token',
          agentAccessEnabled: false,
        },
        createdBy: testUser._id,
        isActive: true,
      });

      const res = await request(app)
        .get(`/api/agents/runtime/pods/${testPod._id}/integrations`)
        .set('Authorization', `Bearer ${tokenRes.body.token}`);

      expect(res.status).toBe(200);
      expect(res.body.integrations).toHaveLength(1);
      expect(res.body.integrations[0].type).toBe('discord');
      expect(res.body.integrations[0].botToken).toBe('discord-bot-token');
    });

    test('should include availableIntegrations in heartbeat payload for eligible agents', async () => {
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Heartbeat Token' });

      await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          channelId: 'discord-channel-heartbeat',
          channelName: 'ops',
          botToken: 'discord-token-heartbeat',
          agentAccessEnabled: true,
        },
        createdBy: testUser._id,
        isActive: true,
      });

      await Integration.create({
        podId: testPod._id,
        type: 'groupme',
        status: 'connected',
        config: {
          groupId: 'groupme-heartbeat-private',
          accessToken: 'groupme-token-heartbeat-private',
          agentAccessEnabled: false,
        },
        createdBy: testUser._id,
        isActive: true,
      });

      await AgentEventService.enqueue({
        agentName: 'commonly-bot',
        podId: testPod._id,
        instanceId: 'default',
        type: 'heartbeat',
        payload: {
          triggerReason: 'test',
        },
      });

      const pollRes = await request(app)
        .get('/api/agents/runtime/events')
        .set('Authorization', `Bearer ${tokenRes.body.token}`);

      expect(pollRes.status).toBe(200);
      const heartbeat = pollRes.body.events.find((event) => event.type === 'heartbeat');
      expect(heartbeat).toBeDefined();
      expect(Array.isArray(heartbeat.payload.availableIntegrations)).toBe(true);
      expect(heartbeat.payload.availableIntegrations).toHaveLength(1);
      expect(heartbeat.payload.availableIntegrations[0]).toMatchObject({
        type: 'discord',
        channelId: 'discord-channel-heartbeat',
        channelName: 'ops',
      });
    });

    test('should accept legacy integrations:read scope alias', async () => {
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'integrations:read'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Legacy Scope Token' });

      const res = await request(app)
        .get(`/api/agents/runtime/pods/${testPod._id}/integrations`)
        .set('Authorization', `Bearer ${tokenRes.body.token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.integrations)).toBe(true);
    });

    test('should fetch Discord integration messages with integration:messages:read scope', async () => {
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'integration:messages:read'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Discord Messages Token' });

      const integration = await Integration.create({
        podId: testPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          channelId: 'discord-channel-abc',
          botToken: 'discord-token-abc',
          agentAccessEnabled: true,
        },
        createdBy: testUser._id,
        isActive: true,
      });

      axios.get.mockResolvedValueOnce({
        data: [
          {
            id: 'msg-1',
            content: 'hello',
            timestamp: new Date().toISOString(),
            author: { id: 'u-1', username: 'alice', bot: false },
            attachments: [],
            reactions: [],
          },
        ],
      });

      const res = await request(app)
        .get(`/api/agents/runtime/pods/${testPod._id}/integrations/${integration._id}/messages?limit=10`)
        .set('Authorization', `Bearer ${tokenRes.body.token}`);

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].authorName).toBe('alice');
    });

    test('should reject integration message fetch for pod the agent is not installed in', async () => {
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'integration:messages:read'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'Cross Pod Token' });

      const otherPod = await Pod.create({
        name: 'Other Pod',
        description: 'Different pod',
        type: 'chat',
        createdBy: testUser._id,
        members: [testUser._id],
      });

      const integration = await Integration.create({
        podId: otherPod._id,
        type: 'discord',
        status: 'connected',
        config: {
          channelId: 'discord-channel-other',
          botToken: 'discord-token-other',
          agentAccessEnabled: true,
        },
        createdBy: testUser._id,
        isActive: true,
      });

      const res = await request(app)
        .get(`/api/agents/runtime/pods/${otherPod._id}/integrations/${integration._id}/messages`)
        .set('Authorization', `Bearer ${tokenRes.body.token}`);

      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Agent token not authorized for this pod');
    });

    test('should fetch GroupMe messages when access token is configured', async () => {
      await request(app)
        .post('/api/registry/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          agentName: 'commonly-bot',
          podId: testPod._id.toString(),
          scopes: ['context:read', 'summaries:read', 'integration:messages:read'],
        });

      const tokenRes = await request(app)
        .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ label: 'GroupMe Messages Token' });

      const integration = await Integration.create({
        podId: testPod._id,
        type: 'groupme',
        status: 'connected',
        config: {
          groupId: 'group-xyz',
          accessToken: 'groupme-token-xyz',
          agentAccessEnabled: true,
        },
        createdBy: testUser._id,
        isActive: true,
      });

      axios.get.mockResolvedValueOnce({
        data: {
          response: {
            messages: [
              {
                id: 'gm-1',
                text: 'groupme hello',
                user_id: 'gm-user-1',
                name: 'bob',
                sender_type: 'user',
                created_at: Math.floor(Date.now() / 1000),
                attachments: [],
              },
            ],
          },
        },
      });

      const res = await request(app)
        .get(`/api/agents/runtime/pods/${testPod._id}/integrations/${integration._id}/messages?limit=20`)
        .set('Authorization', `Bearer ${tokenRes.body.token}`);

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].authorName).toBe('bob');
    });
  });
  });
});
