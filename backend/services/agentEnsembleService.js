const AgentEnsembleState = require('../models/AgentEnsembleState');
const AgentEventService = require('./agentEventService');
const AgentIdentityService = require('./agentIdentityService');
const AgentProfile = require('../models/AgentProfile');
const Pod = require('../models/Pod');

/**
 * Agent Ensemble Service
 *
 * Orchestrates multi-agent discussions in Agent Ensemble Pods (AEP).
 * Handles turn-based conversation flow, checkpointing, and resume capability.
 */
class AgentEnsembleService {
  static resolveNextScheduledAt(schedule, now = Date.now()) {
    if (!schedule?.enabled) return null;
    const frequencyMinutes = Number(schedule.frequencyMinutes) || 20;
    return new Date(now + frequencyMinutes * 60 * 1000);
  }

  /**
   * Start a new agent ensemble discussion
   * @param {string} podId - The pod ID to start discussion in
   * @param {object} options - Optional overrides
   * @param {string} options.topic - Discussion topic (overrides pod config)
   * @param {string} options.createdBy - User ID who started the discussion
   */
  static async startDiscussion(podId, options = {}) {
    // Get pod configuration
    const pod = await Pod.findById(podId);
    if (!pod) {
      throw new Error('Pod not found');
    }

    // Check if there's already an active discussion
    const existing = await AgentEnsembleState.findActiveForPod(podId);
    if (existing) {
      throw new Error('Discussion already active in this pod');
    }

    // Get ensemble config from pod or options
    const config = pod.agentEnsemble || {};
    const participants = options.participants || config.participants || [];

    if (participants.length < 2) {
      throw new Error('At least 2 participants required for ensemble discussion');
    }

    // Ensure all agent users exist
    await Promise.all(
      participants.map(async (p) => {
        const agentUser = await AgentIdentityService.getOrCreateAgentUser(
          p.agentType,
          { instanceId: p.instanceId || 'default' },
        );
        // Ensure agent is a member of the pod
        await AgentIdentityService.ensureAgentInPod(agentUser, podId);
      }),
    );

    // Find starter agent (first with 'starter' role, or first in list)
    const starterIndex = participants.findIndex((p) => p.role === 'starter');
    const starterParticipant = starterIndex >= 0
      ? participants[starterIndex]
      : participants[0];

    const scheduleConfig = config.schedule || {};
    const nextScheduledAt = AgentEnsembleService.resolveNextScheduledAt(scheduleConfig);

    // Create ensemble state
    const state = await AgentEnsembleState.create({
      podId,
      status: 'active',
      topic: options.topic || config.topic || 'Open discussion',
      participants: participants.map((p, i) => ({
        agentType: p.agentType,
        instanceId: p.instanceId || 'default',
        displayName: p.displayName,
        role: i === 0 && !participants.some((x) => x.role === 'starter')
          ? 'starter'
          : (p.role || 'responder'),
      })),
      turnState: {
        currentAgent: {
          agentType: starterParticipant.agentType,
          instanceId: starterParticipant.instanceId || 'default',
        },
        turnNumber: 0,
        roundNumber: 0,
        turnStartedAt: new Date(),
        waitingForResponse: true,
      },
      stopConditions: {
        maxMessages: options.maxMessages || config.stopConditions?.maxMessages || 20,
        maxRounds: options.maxRounds || config.stopConditions?.maxRounds || 5,
        maxDurationMinutes: options.maxDurationMinutes
          || config.stopConditions?.maxDurationMinutes || 60,
      },
      stats: {
        startedAt: new Date(),
        lastActivityAt: new Date(),
      },
      schedule: {
        enabled: Boolean(scheduleConfig.enabled),
        cronExpression: scheduleConfig.cronExpression,
        timezone: scheduleConfig.timezone || 'UTC',
        lastScheduledAt: scheduleConfig.enabled ? new Date() : null,
        nextScheduledAt,
      },
      createdBy: options.createdBy,
    });

    // Enqueue the first turn event
    await AgentEnsembleService.enqueueTurnEvent(state);

    console.log(`[ensemble] Started discussion in pod ${podId} with ${participants.length} agents`);

    return state;
  }

  /**
   * Enqueue an ensemble.turn event for the current agent
   */
  static async enqueueTurnEvent(state) {
    const { turnState, participants, topic, podId } = state;
    const currentAgent = turnState.currentAgent;

    if (!currentAgent?.agentType) {
      console.warn('[ensemble] No current agent to enqueue turn for');
      return;
    }

    let agentProfilePayload = null;
    try {
      const profile = await AgentProfile.findOne({
        podId,
        agentName: currentAgent.agentType?.toLowerCase?.() || currentAgent.agentType,
        instanceId: currentAgent.instanceId || 'default',
      });
      if (profile) {
        agentProfilePayload = {
          name: profile.name,
          purpose: profile.purpose,
          instructions: profile.instructions,
          persona: profile.persona,
          toolPolicy: profile.toolPolicy,
          contextPolicy: profile.contextPolicy,
          systemPrompt: typeof profile.buildSystemPrompt === 'function'
            ? profile.buildSystemPrompt()
            : null,
        };
      }
    } catch (error) {
      console.warn('[ensemble] Failed to load agent profile:', error.message);
    }

    // Build context for the turn
    const context = {
      topic,
      turnNumber: turnState.turnNumber,
      roundNumber: turnState.roundNumber,
      isStarter: turnState.turnNumber === 0,
      recentHistory: state.checkpoint?.recentHistory || [],
      keyPoints: state.keyPoints?.slice(-5) || [],
    };

    await AgentEventService.enqueue({
      agentName: currentAgent.agentType,
      instanceId: currentAgent.instanceId || 'default',
      podId,
      type: 'ensemble.turn',
      payload: {
        ensembleId: state._id.toString(),
        context,
        agentProfile: agentProfilePayload,
        participants: participants.map((p) => ({
          agentType: p.agentType,
          instanceId: p.instanceId,
          displayName: p.displayName,
          role: p.role,
        })),
      },
    });

    console.log(`[ensemble] Enqueued turn ${turnState.turnNumber} for ${currentAgent.agentType}`);
  }

  /**
   * Process an agent's response and advance the discussion
   * @param {string} ensembleId - The ensemble state ID
   * @param {object} response - The agent's response
   * @param {string} response.agentType - Agent that responded
   * @param {string} response.content - Response content
   * @param {string} response.messageId - ID of the posted message
   */
  static async processAgentResponse(ensembleId, response) {
    const state = await AgentEnsembleState.findById(ensembleId);
    if (!state) {
      throw new Error('Ensemble state not found');
    }

    if (state.status !== 'active') {
      console.log(`[ensemble] Ignoring response for non-active ensemble: ${state.status}`);
      return state;
    }

    const { turnState } = state;

    // STRICT verification - reject wrong agent
    if (
      response.agentType !== turnState.currentAgent?.agentType ||
      (response.instanceId || 'default') !== (turnState.currentAgent?.instanceId || 'default')
    ) {
      const expected = `${turnState.currentAgent?.agentType}:${
        turnState.currentAgent?.instanceId || 'default'
      }`;
      const received = `${response.agentType}:${response.instanceId || 'default'}`;
      throw new Error(`Wrong agent responded. Expected ${expected}, got ${received}`);
    }

    // Check for duplicate responses
    if (state.lastProcessedMessageId === response.messageId) {
      console.log(
        `[ensemble] Duplicate response from ${response.agentType}:${
          response.instanceId || 'default'
        } ignored`,
      );
      return state;
    }

    // Update stats
    state.stats.totalMessages += 1;
    state.stats.lastActivityAt = new Date();
    turnState.waitingForResponse = false;

    // Add to recent history
    if (!state.checkpoint) {
      state.checkpoint = { recentHistory: [] };
    }
    // Update checkpoint with VERIFIED agent identity
    state.checkpoint.recentHistory.push({
      agentType: turnState.currentAgent.agentType, // Use verified identity
      instanceId: turnState.currentAgent.instanceId,
      content: response.content?.substring(0, 500),
      timestamp: new Date(),
    });

    // Keep only last 10 messages in history
    if (state.checkpoint.recentHistory.length > 10) {
      state.checkpoint.recentHistory = state.checkpoint.recentHistory.slice(-10);
    }

    // Update checkpoint
    state.lastProcessedMessageId = response.messageId;
    state.checkpoint.lastMessageId = response.messageId;
    state.checkpoint.savedAt = new Date();

    // Check stop conditions
    const stopReason = AgentEnsembleService.checkStopConditions(state);
    if (stopReason) {
      await AgentEnsembleService.completeDiscussion(state._id, stopReason);
      return state;
    }

    // Advance to next turn
    state.advanceTurn();
    await state.save();

    // Enqueue next turn event
    await AgentEnsembleService.enqueueTurnEvent(state);

    return state;
  }

  /**
   * Check if any stop conditions are met
   */
  static checkStopConditions(state) {
    const { stopConditions, stats, turnState } = state;

    // Check max messages
    if (stats.totalMessages >= stopConditions.maxMessages) {
      return 'max_messages';
    }

    // Check max rounds
    if (turnState.roundNumber >= stopConditions.maxRounds) {
      return 'max_rounds';
    }

    // Check max duration
    if (stopConditions.maxDurationMinutes > 0 && stats.startedAt) {
      const elapsed = (Date.now() - stats.startedAt.getTime()) / 1000 / 60;
      if (elapsed >= stopConditions.maxDurationMinutes) {
        return 'max_duration';
      }
    }

    return null;
  }

  /**
   * Pause a discussion (can be resumed later)
   */
  static async pauseDiscussion(podId) {
    const state = await AgentEnsembleState.findActiveForPod(podId);
    if (!state) {
      throw new Error('No active discussion found');
    }

    state.status = 'paused';
    state.stats.pausedAt = new Date();
    await state.save();

    console.log(`[ensemble] Paused discussion in pod ${podId}`);
    return state;
  }

  /**
   * Resume a paused discussion
   */
  static async resumeDiscussion(podId) {
    const state = await AgentEnsembleState.findOne({
      podId,
      status: 'paused',
    }).sort({ 'stats.pausedAt': -1 });

    if (!state) {
      throw new Error('No paused discussion found to resume');
    }

    state.status = 'active';
    state.turnState.turnStartedAt = new Date();
    state.turnState.waitingForResponse = true;
    state.stats.lastActivityAt = new Date();
    await state.save();

    // Re-enqueue the current turn
    await AgentEnsembleService.enqueueTurnEvent(state);

    console.log(`[ensemble] Resumed discussion in pod ${podId} at turn ${state.turnState.turnNumber}`);
    return state;
  }

  /**
   * Complete a discussion
   */
  static async completeDiscussion(ensembleId, reason = 'manual') {
    const state = await AgentEnsembleState.findById(ensembleId);
    if (!state) {
      throw new Error('Ensemble state not found');
    }

    state.status = 'completed';
    state.stats.completedAt = new Date();
    state.stats.completionReason = reason;

    // Generate summary from key points
    if (state.keyPoints?.length > 0) {
      state.summary = {
        keyInsights: state.keyPoints.map((kp) => kp.content),
        generatedAt: new Date(),
      };
    }

    await state.save();

    if (state.schedule?.enabled) {
      state.schedule.lastScheduledAt = new Date();
      state.schedule.nextScheduledAt = AgentEnsembleService.resolveNextScheduledAt(state.schedule);
      await state.save();
    }

    console.log(`[ensemble] Completed discussion ${ensembleId}: ${reason}`);
    return state;
  }

  /**
   * Get current state for a pod
   */
  static async getState(podId) {
    // Try to find active or paused state
    const state = await AgentEnsembleState.findOne({
      podId,
      status: { $in: ['active', 'paused'] },
    }).sort({ createdAt: -1 });

    if (state) {
      return state;
    }

    // Return most recent completed state
    return AgentEnsembleState.findOne({ podId })
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * Update ensemble configuration
   */
  static async updateConfig(podId, config) {
    const state = await AgentEnsembleState.findOne({
      podId,
      status: { $in: ['active', 'pending', 'paused'] },
    });

    if (state) {
      // Allow adding participants but not removing/reordering during active discussion
      if (state.status === 'active' && config.participants) {
        const currentCount = state.participants?.length || 0;
        const newCount = config.participants?.length || 0;

        // Prevent removing participants
        if (newCount < currentCount) {
          throw new Error(
            'Cannot remove participants during active discussion. Please stop the discussion first.',
          );
        }

        // Check if existing participants are being modified (only check existing ones)
        const existingChanged = config.participants.slice(0, currentCount).some((p, i) => {
          const current = state.participants[i];
          return (
            p.agentType !== current.agentType ||
            (p.instanceId || 'default') !== (current.instanceId || 'default')
          );
        });

        if (existingChanged) {
          throw new Error('Cannot modify existing participant identities during active discussion');
        }

        // If adding participants, ensure they're added to the pod
        if (newCount > currentCount) {
          const newParticipants = config.participants.slice(currentCount);
          await Promise.all(
            newParticipants.map(async (p) => {
              const agentUser = await AgentIdentityService.getOrCreateAgentUser(
                p.agentType,
                { instanceId: p.instanceId || 'default' },
              );
              await AgentIdentityService.ensureAgentInPod(agentUser, podId);
            }),
          );
        }
      }

      if (config.topic !== undefined) state.topic = config.topic;
      // Allow adding participants even if active, but not removing
      if (config.participants) {
        if (state.status === 'active') {
          // Only allow adding participants (already validated above)
          state.participants = config.participants;
        } else {
          // Full update allowed when not active
          state.participants = config.participants;
        }
      }
      if (config.stopConditions) {
        state.stopConditions = { ...state.stopConditions, ...config.stopConditions };
      }
      if (config.schedule) {
        const nextScheduledAt = AgentEnsembleService.resolveNextScheduledAt(config.schedule);
        state.schedule = {
          ...state.schedule,
          ...config.schedule,
          nextScheduledAt,
        };
      }
      await state.save();
    }

    const pod = await Pod.findById(podId);
    if (pod) {
      pod.agentEnsemble = { ...pod.agentEnsemble, ...config };
      await pod.save();
      if (!state) {
        const scheduleConfig = config.schedule || pod.agentEnsemble?.schedule || {};
        const participants = config.participants || pod.agentEnsemble?.participants || [];
        if (scheduleConfig.enabled && participants.length >= 2) {
          const nextScheduledAt = AgentEnsembleService.resolveNextScheduledAt(scheduleConfig);
          const pendingState = await AgentEnsembleState.create({
            podId,
            status: 'pending',
            topic: config.topic || pod.agentEnsemble?.topic || 'Open discussion',
            participants,
            stopConditions: {
              maxMessages: config.stopConditions?.maxMessages || pod.agentEnsemble?.stopConditions?.maxMessages || 20,
              maxRounds: config.stopConditions?.maxRounds || pod.agentEnsemble?.stopConditions?.maxRounds || 5,
              maxDurationMinutes: config.stopConditions?.maxDurationMinutes
                || pod.agentEnsemble?.stopConditions?.maxDurationMinutes || 60,
            },
            schedule: {
              enabled: Boolean(scheduleConfig.enabled),
              cronExpression: scheduleConfig.cronExpression,
              timezone: scheduleConfig.timezone || 'UTC',
              lastScheduledAt: null,
              nextScheduledAt,
            },
            createdBy: pod.createdBy,
          });
          return pendingState;
        }
      }
      return state || pod;
    }

    throw new Error('Pod not found');
  }

  /**
   * Resume all paused discussions after restart
   * Called during server startup
   */
  static async resumeAllPaused() {
    const pausedStates = await AgentEnsembleState.findPausedForResume();

    console.log(`[ensemble] Found ${pausedStates.length} paused discussions to resume`);

    await Promise.allSettled(
      pausedStates.map(async (state) => {
        try {
          state.status = 'active';
          state.turnState.turnStartedAt = new Date();
          state.turnState.waitingForResponse = true;
          await state.save();
          await AgentEnsembleService.enqueueTurnEvent(state);
          console.log(`[ensemble] Resumed pod ${state.podId} from turn ${state.turnState.turnNumber}`);
        } catch (err) {
          console.error(`[ensemble] Failed to resume pod ${state.podId}:`, err.message);
        }
      }),
    );
  }

  /**
   * Process scheduled ensembles
   * Called by scheduler service
   */
  static async processScheduled() {
    const dueStates = await AgentEnsembleState.findScheduledDue();

    console.log(`[ensemble] Found ${dueStates.length} scheduled discussions to start`);

    await Promise.allSettled(
      dueStates.map(async (state) => {
        try {
          // Check if there's already an active discussion
          const existing = await AgentEnsembleState.findActiveForPod(state.podId);
          if (existing) {
            // Complete the active discussion before starting new one
            console.log(`[ensemble] Auto-completing active discussion before starting scheduled one in pod ${state.podId}`);
            await AgentEnsembleService.completeDiscussion(existing._id, 'scheduled_restart');
          }

          // Start new discussion
          await AgentEnsembleService.startDiscussion(state.podId, {
            topic: state.topic,
            participants: state.participants,
          });

          // Update schedule
          state.schedule.lastScheduledAt = new Date();
          state.schedule.nextScheduledAt = AgentEnsembleService.resolveNextScheduledAt(state.schedule);
          await state.save();
        } catch (err) {
          console.error(`[ensemble] Failed to start scheduled discussion:`, err.message);
        }
      }),
    );
  }
}

module.exports = AgentEnsembleService;
