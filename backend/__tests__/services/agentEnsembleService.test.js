const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const AgentEnsembleService = require('../../services/agentEnsembleService');
const AgentEnsembleState = require('../../models/AgentEnsembleState');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentProfile = require('../../models/AgentProfile');

// Mock dependencies
jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn().mockImplementation((agentType, options) =>
    Promise.resolve({
      _id: `user-${agentType}-${options.instanceId}`,
      username: `${agentType}-${options.instanceId}`,
      isBot: true,
      botMetadata: {
        agentName: agentType,
        instanceId: options.instanceId,
      },
    }),
  ),
  ensureAgentInPod: jest.fn().mockResolvedValue({}),
}));

const AgentEventService = require('../../services/agentEventService');
const AgentIdentityService = require('../../services/agentIdentityService');

describe('AgentEnsembleService', () => {
  let mongoServer;
  let testUser;
  let testPod;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clear all collections
    await Promise.all([
      AgentEnsembleState.deleteMany({}),
      Pod.deleteMany({}),
      User.deleteMany({}),
      AgentProfile.deleteMany({}),
    ]);

    jest.clearAllMocks();

    // Create test user
    testUser = await User.create({
      username: 'testuser',
      email: 'test@example.com',
      password: 'hashedpassword',
    });

    // Create test pod
    testPod = await Pod.create({
      name: 'Test Ensemble Pod',
      type: 'agent-ensemble',
      createdBy: testUser._id,
      members: [testUser._id],
      agentEnsemble: {
        enabled: true,
        topic: 'Test Discussion',
        participants: [
          {
            agentType: 'openclaw',
            instanceId: 'cuz',
            displayName: 'Cuz',
            role: 'starter',
          },
          {
            agentType: 'openclaw',
            instanceId: 'tarik',
            displayName: 'Tarik',
            role: 'responder',
          },
        ],
        stopConditions: {
          maxMessages: 20,
          maxRounds: 5,
          maxDurationMinutes: 60,
        },
      },
    });
  });

  describe('Fix 1: Adding participants during active discussion', () => {
    it('should allow adding a third participant to an active discussion', async () => {
      // Start a discussion with 2 participants
      const state = await AgentEnsembleService.startDiscussion(testPod._id, {
        createdBy: testUser._id,
      });

      expect(state.status).toBe('active');
      expect(state.participants).toHaveLength(2);

      // Add a third participant
      const updatedConfig = {
        participants: [
          ...testPod.agentEnsemble.participants,
          {
            agentType: 'openclaw',
            instanceId: 'sam',
            displayName: 'Sam',
            role: 'responder',
          },
        ],
      };

      await AgentEnsembleService.updateConfig(testPod._id, updatedConfig);

      // Verify the participant was added
      const updatedState = await AgentEnsembleState.findById(state._id);
      expect(updatedState.participants).toHaveLength(3);
      expect(updatedState.participants[2].agentType).toBe('openclaw');
      expect(updatedState.participants[2].instanceId).toBe('sam');
      expect(updatedState.participants[2].displayName).toBe('Sam');

      // Verify agent was added to pod
      expect(AgentIdentityService.getOrCreateAgentUser).toHaveBeenCalledWith('openclaw', {
        instanceId: 'sam',
      });
      expect(AgentIdentityService.ensureAgentInPod).toHaveBeenCalled();
    });

    it('should prevent removing participants during active discussion', async () => {
      // Start a discussion with 2 participants
      const state = await AgentEnsembleService.startDiscussion(testPod._id, {
        createdBy: testUser._id,
      });

      expect(state.status).toBe('active');
      expect(state.participants).toHaveLength(2);

      // Try to remove a participant
      const updatedConfig = {
        participants: [testPod.agentEnsemble.participants[0]], // Only keep first participant
      };

      await expect(AgentEnsembleService.updateConfig(testPod._id, updatedConfig)).rejects.toThrow(
        'Cannot remove participants during active discussion',
      );
    });

    it('should prevent modifying existing participant identities during active discussion', async () => {
      // Start a discussion with 2 participants
      const state = await AgentEnsembleService.startDiscussion(testPod._id, {
        createdBy: testUser._id,
      });

      expect(state.status).toBe('active');

      // Try to change first participant's instanceId
      const updatedConfig = {
        participants: [
          {
            agentType: 'openclaw',
            instanceId: 'different-id', // Changed from 'cuz'
            displayName: 'Cuz',
            role: 'starter',
          },
          testPod.agentEnsemble.participants[1],
        ],
      };

      await expect(AgentEnsembleService.updateConfig(testPod._id, updatedConfig)).rejects.toThrow(
        'Cannot modify existing participant identities during active discussion',
      );
    });

    it('should allow adding multiple participants at once', async () => {
      // Start a discussion with 2 participants
      const state = await AgentEnsembleService.startDiscussion(testPod._id, {
        createdBy: testUser._id,
      });

      // Add two more participants
      const updatedConfig = {
        participants: [
          ...testPod.agentEnsemble.participants,
          {
            agentType: 'openclaw',
            instanceId: 'sam',
            displayName: 'Sam',
            role: 'responder',
          },
          {
            agentType: 'openclaw',
            instanceId: 'alex',
            displayName: 'Alex',
            role: 'responder',
          },
        ],
      };

      await AgentEnsembleService.updateConfig(testPod._id, updatedConfig);

      const updatedState = await AgentEnsembleState.findById(state._id);
      expect(updatedState.participants).toHaveLength(4);
      expect(updatedState.participants[2].instanceId).toBe('sam');
      expect(updatedState.participants[3].instanceId).toBe('alex');
    });
  });

  describe('Turn policy: NO_REPLY skips message', () => {
    it('advances turn without incrementing message count when NO_REPLY', async () => {
      const state = await AgentEnsembleService.startDiscussion(testPod._id, {
        createdBy: testUser._id,
      });

      const initialTurn = state.turnState.turnNumber;
      const initialMessages = state.stats.totalMessages;

      await AgentEnsembleService.processAgentResponse(state._id, {
        agentType: state.turnState.currentAgent.agentType,
        instanceId: state.turnState.currentAgent.instanceId,
        content: 'NO_REPLY',
        messageId: 'm-no-reply',
      });

      const updated = await AgentEnsembleState.findById(state._id);
      expect(updated.stats.totalMessages).toBe(initialMessages);
      expect(updated.turnState.turnNumber).toBe(initialTurn + 1);
    });
  });

  describe('Fix 2: Scheduled discussions', () => {
    it('reuses completed scheduled state instead of creating duplicates', async () => {
      await AgentEnsembleState.create({
        podId: testPod._id,
        status: 'completed',
        topic: 'Old Scheduled',
        participants: testPod.agentEnsemble.participants,
        stopConditions: {
          maxMessages: 20,
          maxRounds: 5,
          maxDurationMinutes: 60,
        },
        stats: {
          totalMessages: 0,
          completedAt: new Date(Date.now() - 1000),
          completionReason: 'scheduled_restart',
        },
        schedule: {
          enabled: true,
          cronExpression: '*/5 * * * *',
          timezone: 'UTC',
          nextScheduledAt: new Date(Date.now() + 60_000),
        },
      });

      await AgentEnsembleService.updateConfig(testPod._id, {
        schedule: { enabled: true, frequencyMinutes: 20, timezone: 'UTC' },
        participants: testPod.agentEnsemble.participants,
      });

      const scheduledStates = await AgentEnsembleState.find({
        podId: testPod._id,
        status: { $in: ['pending', 'completed'] },
        'schedule.enabled': true,
      });

      expect(scheduledStates).toHaveLength(1);
      expect(['pending', 'completed']).toContain(scheduledStates[0].status);
    });
    it('should auto-complete active discussion before starting scheduled one', async () => {
      // Create a pending scheduled state
      const scheduledState = await AgentEnsembleState.create({
        podId: testPod._id,
        status: 'pending',
        topic: 'Scheduled Discussion',
        participants: testPod.agentEnsemble.participants,
        turnState: {
          currentAgent: null,
          turnNumber: 0,
          roundNumber: 0,
        },
        stopConditions: {
          maxMessages: 20,
          maxRounds: 5,
          maxDurationMinutes: 60,
        },
        stats: {
          totalMessages: 0,
          startedAt: new Date(),
          lastActivityAt: new Date(),
        },
        schedule: {
          enabled: true,
          cronExpression: '*/5 * * * *',
          timezone: 'UTC',
          nextScheduledAt: new Date(Date.now() - 1000), // Past due
        },
      });

      // Start an active discussion
      const activeState = await AgentEnsembleService.startDiscussion(testPod._id, {
        topic: 'Active Discussion',
        createdBy: testUser._id,
      });

      expect(activeState.status).toBe('active');

      // Process scheduled discussions
      await AgentEnsembleService.processScheduled();

      // Verify the active discussion was completed
      const completedState = await AgentEnsembleState.findById(activeState._id);
      expect(completedState.status).toBe('completed');
      expect(completedState.stats.completionReason).toBe('scheduled_restart');

      // Verify a new discussion was started
      const newActiveState = await AgentEnsembleState.findOne({
        podId: testPod._id,
        status: 'active',
      }).sort({ createdAt: -1 });

      expect(newActiveState).toBeTruthy();
      expect(newActiveState._id.toString()).not.toBe(activeState._id.toString());
      expect(newActiveState.topic).toBe('Scheduled Discussion');
    });

    it('should start scheduled discussion when no active discussion exists', async () => {
      // Create a pending scheduled state
      await AgentEnsembleState.create({
        podId: testPod._id,
        status: 'pending',
        topic: 'Scheduled Discussion',
        participants: testPod.agentEnsemble.participants,
        turnState: {
          currentAgent: null,
          turnNumber: 0,
          roundNumber: 0,
        },
        stopConditions: {
          maxMessages: 20,
          maxRounds: 5,
          maxDurationMinutes: 60,
        },
        stats: {
          totalMessages: 0,
          startedAt: new Date(),
          lastActivityAt: new Date(),
        },
        schedule: {
          enabled: true,
          nextScheduledAt: new Date(Date.now() - 1000), // Past due
        },
      });

      // No active discussion exists
      const activeBefore = await AgentEnsembleState.findActiveForPod(testPod._id);
      expect(activeBefore).toBeFalsy();

      // Process scheduled discussions
      await AgentEnsembleService.processScheduled();

      // Verify a new discussion was started
      const activeAfter = await AgentEnsembleState.findActiveForPod(testPod._id);
      expect(activeAfter).toBeTruthy();
      expect(activeAfter.status).toBe('active');
      expect(activeAfter.topic).toBe('Scheduled Discussion');
    });

    it('should update schedule after starting discussion', async () => {
      const scheduledState = await AgentEnsembleState.create({
        podId: testPod._id,
        status: 'pending',
        topic: 'Scheduled Discussion',
        participants: testPod.agentEnsemble.participants,
        turnState: {
          currentAgent: null,
          turnNumber: 0,
          roundNumber: 0,
        },
        stopConditions: {
          maxMessages: 20,
          maxRounds: 5,
          maxDurationMinutes: 60,
        },
        stats: {
          totalMessages: 0,
          startedAt: new Date(),
          lastActivityAt: new Date(),
        },
        schedule: {
          enabled: true,
          frequencyMinutes: 20,
          nextScheduledAt: new Date(Date.now() - 1000),
        },
      });

      const nextScheduledBefore = scheduledState.schedule.nextScheduledAt;

      // Process scheduled discussions
      await AgentEnsembleService.processScheduled();

      // Verify schedule was updated
      const updatedScheduledState = await AgentEnsembleState.findById(scheduledState._id);
      expect(updatedScheduledState.schedule.lastScheduledAt).toBeTruthy();
      expect(updatedScheduledState.schedule.nextScheduledAt.getTime()).toBeGreaterThan(
        nextScheduledBefore.getTime(),
      );
    });

    it('should handle errors gracefully when starting scheduled discussion fails', async () => {
      // Create a scheduled state with invalid participants (empty array)
      await AgentEnsembleState.create({
        podId: testPod._id,
        status: 'pending',
        topic: 'Invalid Discussion',
        participants: [], // Invalid - needs at least 2
        turnState: {
          currentAgent: null,
          turnNumber: 0,
          roundNumber: 0,
        },
        stopConditions: {
          maxMessages: 20,
          maxRounds: 5,
          maxDurationMinutes: 60,
        },
        stats: {
          totalMessages: 0,
          startedAt: new Date(),
          lastActivityAt: new Date(),
        },
        schedule: {
          enabled: true,
          nextScheduledAt: new Date(Date.now() - 1000),
        },
      });

      // Should not throw error - uses Promise.allSettled
      await expect(AgentEnsembleService.processScheduled()).resolves.not.toThrow();

      // Verify no active discussion was created
      const active = await AgentEnsembleState.findActiveForPod(testPod._id);
      expect(active).toBeFalsy();
    });
  });

  describe('Integration: Third agent participation in next round', () => {
    it('should include third agent in turn rotation after being added', async () => {
      // Start discussion with 2 agents
      const state = await AgentEnsembleService.startDiscussion(testPod._id, {
        createdBy: testUser._id,
      });

      expect(state.turnState.turnNumber).toBe(0);
      expect(state.turnState.currentAgent.instanceId).toBe('cuz'); // Starter

      // Simulate first agent response
      await AgentEnsembleService.processAgentResponse(state._id, {
        agentType: 'openclaw',
        instanceId: 'cuz',
        content: 'First message from Cuz',
        messageId: 'msg-1',
      });

      // Verify turn advanced to second agent
      let updatedState = await AgentEnsembleState.findById(state._id);
      expect(updatedState.turnState.turnNumber).toBe(1);
      expect(updatedState.turnState.currentAgent.instanceId).toBe('tarik');

      // Add third agent before Tarik responds
      await AgentEnsembleService.updateConfig(testPod._id, {
        participants: [
          ...testPod.agentEnsemble.participants,
          {
            agentType: 'openclaw',
            instanceId: 'sam',
            displayName: 'Sam',
            role: 'responder',
          },
        ],
      });

      // Verify third agent was added
      updatedState = await AgentEnsembleState.findById(state._id);
      expect(updatedState.participants).toHaveLength(3);

      // Simulate second agent response (Tarik)
      await AgentEnsembleService.processAgentResponse(state._id, {
        agentType: 'openclaw',
        instanceId: 'tarik',
        content: 'Response from Tarik',
        messageId: 'msg-2',
      });

      // Verify turn advanced to THIRD agent (Sam), not back to first
      updatedState = await AgentEnsembleState.findById(state._id);
      expect(updatedState.turnState.turnNumber).toBe(2);
      expect(updatedState.turnState.currentAgent.instanceId).toBe('sam');

      // Simulate third agent response
      await AgentEnsembleService.processAgentResponse(state._id, {
        agentType: 'openclaw',
        instanceId: 'sam',
        content: 'First message from Sam',
        messageId: 'msg-3',
      });

      // Verify round completed and back to first agent
      updatedState = await AgentEnsembleState.findById(state._id);
      expect(updatedState.turnState.turnNumber).toBe(3);
      expect(updatedState.turnState.roundNumber).toBe(1); // First round completed
      expect(updatedState.turnState.currentAgent.instanceId).toBe('cuz'); // Back to starter
    });
  });

  describe('Observer participants', () => {
    it('skips observers in turn rotation', async () => {
      testPod.agentEnsemble.participants = [
        {
          agentType: 'openclaw',
          instanceId: 'cuz',
          displayName: 'Cuz',
          role: 'starter',
        },
        {
          agentType: 'openclaw',
          instanceId: 'observer',
          displayName: 'Observer',
          role: 'observer',
        },
        {
          agentType: 'openclaw',
          instanceId: 'tarik',
          displayName: 'Tarik',
          role: 'responder',
        },
      ];
      await testPod.save();

      const state = await AgentEnsembleService.startDiscussion(testPod._id, {
        createdBy: testUser._id,
      });

      expect(state.turnState.currentAgent.instanceId).toBe('cuz');

      await AgentEnsembleService.processAgentResponse(state._id, {
        agentType: 'openclaw',
        instanceId: 'cuz',
        content: 'Starter message',
        messageId: 'msg-1',
      });

      const updatedState = await AgentEnsembleState.findById(state._id);
      expect(updatedState.turnState.currentAgent.instanceId).toBe('tarik');
      expect(AgentEventService.enqueue).toHaveBeenCalled();
    });

    it('requires at least two speaking participants', async () => {
      testPod.agentEnsemble.participants = [
        {
          agentType: 'openclaw',
          instanceId: 'cuz',
          displayName: 'Cuz',
          role: 'starter',
        },
        {
          agentType: 'openclaw',
          instanceId: 'observer',
          displayName: 'Observer',
          role: 'observer',
        },
      ];
      await testPod.save();

      await expect(
        AgentEnsembleService.startDiscussion(testPod._id, {
          createdBy: testUser._id,
        }),
      ).rejects.toThrow('At least 2 speaking participants required for ensemble discussion');
    });
  });
});
