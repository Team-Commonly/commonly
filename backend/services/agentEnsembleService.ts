// eslint-disable-next-line global-require
const AgentEnsembleState = require('../models/AgentEnsembleState');
// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line global-require
const AgentIdentityService = require('./agentIdentityService');
// eslint-disable-next-line global-require
const AgentProfile = require('../models/AgentProfile');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');

interface ScheduleConfig {
  enabled?: boolean;
  frequencyMinutes?: number;
  cronExpression?: string;
  timezone?: string;
  lastScheduledAt?: Date | null;
  nextScheduledAt?: Date | null;
}

interface ParticipantConfig {
  agentType: string;
  instanceId?: string;
  displayName?: string;
  role?: string;
}

interface StopConditions {
  maxMessages?: number;
  maxRounds?: number;
  maxDurationMinutes?: number;
}

interface StartDiscussionOptions {
  topic?: string;
  createdBy?: string;
  participants?: ParticipantConfig[];
  maxMessages?: number;
  maxRounds?: number;
  maxDurationMinutes?: number;
}

interface AgentRef {
  agentType: string;
  instanceId?: string;
}

interface TurnState {
  currentAgent: AgentRef;
  turnNumber: number;
  roundNumber: number;
  turnStartedAt: Date;
  waitingForResponse: boolean;
}

interface CheckpointEntry {
  agentType: string;
  instanceId?: string;
  content: string;
  timestamp: Date;
}

interface Checkpoint {
  recentHistory: CheckpointEntry[];
  lastMessageId?: string;
  savedAt?: Date;
}

interface EnsembleStats {
  startedAt?: Date;
  lastActivityAt?: Date;
  pausedAt?: Date;
  completedAt?: Date;
  completionReason?: string;
  totalMessages: number;
}

interface KeyPoint {
  content: string;
}

interface EnsembleStateDoc {
  _id: { toString(): string };
  podId: unknown;
  status: string;
  topic: string;
  participants: ParticipantConfig[];
  turnState: TurnState;
  stopConditions: Required<StopConditions>;
  stats: EnsembleStats;
  schedule?: ScheduleConfig & {
    lastScheduledAt?: Date | null;
    nextScheduledAt?: Date | null;
  };
  checkpoint?: Checkpoint;
  keyPoints?: KeyPoint[];
  summary?: {
    keyInsights: string[];
    generatedAt: Date;
  };
  lastProcessedMessageId?: string;
  createdBy?: unknown;
  advanceTurn(): void;
  save(): Promise<void>;
}

interface AgentProfileDoc {
  name?: string;
  purpose?: string;
  instructions?: string;
  persona?: string;
  toolPolicy?: unknown;
  contextPolicy?: unknown;
  buildSystemPrompt?: () => string;
}

interface UpdateConfigOptions {
  topic?: string;
  participants?: ParticipantConfig[];
  stopConditions?: StopConditions;
  schedule?: ScheduleConfig;
}

class AgentEnsembleService {
  static resolveNextScheduledAt(
    schedule: ScheduleConfig | null | undefined,
    now = Date.now(),
  ): Date | null {
    if (!schedule?.enabled) return null;
    const frequencyMinutes = Number(schedule.frequencyMinutes) || 20;
    return new Date(now + frequencyMinutes * 60 * 1000);
  }

  static async startDiscussion(
    podId: string,
    options: StartDiscussionOptions = {},
  ): Promise<EnsembleStateDoc> {
    const pod = await Pod.findById(podId);
    if (!pod) {
      throw new Error('Pod not found');
    }

    const existing = await AgentEnsembleState.findOne({
      podId,
      status: { $in: ['active', 'paused'] },
    }).sort({ createdAt: -1 });
    if (existing) {
      if (existing.status === 'paused') {
        throw new Error('Discussion is paused in this pod. Please resume instead.');
      }
      throw new Error('Discussion already active in this pod');
    }

    const config = pod.agentEnsemble || {};
    const participants: ParticipantConfig[] = options.participants || config.participants || [];
    const speakingParticipants = participants.filter((p) => p.role !== 'observer');

    if (speakingParticipants.length < 2) {
      throw new Error('At least 2 speaking participants required for ensemble discussion');
    }

    await Promise.all(
      participants.map(async (p) => {
        const agentUser = await AgentIdentityService.getOrCreateAgentUser(
          p.agentType,
          { instanceId: p.instanceId || 'default' },
        );
        await AgentIdentityService.ensureAgentInPod(agentUser, podId);
      }),
    );

    const starterIndex = participants.findIndex((p) => p.role === 'starter');
    const starterParticipant = starterIndex >= 0 ? participants[starterIndex] : speakingParticipants[0];

    const scheduleConfig: ScheduleConfig = config.schedule || {};
    const nextScheduledAt = AgentEnsembleService.resolveNextScheduledAt(scheduleConfig);

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

    await AgentEnsembleService.enqueueTurnEvent(state);
    console.log(`[ensemble] Started discussion in pod ${podId} with ${participants.length} agents`);
    return state as EnsembleStateDoc;
  }

  static async enqueueTurnEvent(state: EnsembleStateDoc): Promise<void> {
    const { turnState, participants, topic, podId } = state;
    const speakingParticipants = (participants || []).filter((p) => p.role !== 'observer');
    if (!speakingParticipants.length) {
      console.warn('[ensemble] No speaking participants available for turn rotation');
      return;
    }

    const expectedAgent = speakingParticipants[turnState.turnNumber % speakingParticipants.length];
    const currentAgentMatches = turnState.currentAgent?.agentType === expectedAgent.agentType
      && (turnState.currentAgent?.instanceId || 'default') === (expectedAgent.instanceId || 'default');

    if (!currentAgentMatches) {
      state.turnState.currentAgent = {
        agentType: expectedAgent.agentType,
        instanceId: expectedAgent.instanceId || 'default',
      };
      await state.save();
    }

    const currentAgent = state.turnState.currentAgent;
    if (!currentAgent?.agentType) {
      console.warn('[ensemble] No current agent to enqueue turn for');
      return;
    }

    let agentProfilePayload: Record<string, unknown> | null = null;
    try {
      const profile: AgentProfileDoc | null = await AgentProfile.findOne({
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
      const err = error as { message?: string };
      console.warn('[ensemble] Failed to load agent profile:', err.message);
    }

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

  static async processAgentResponse(
    ensembleId: string,
    response: { agentType: string; instanceId?: string; content?: string; messageId?: string },
  ): Promise<EnsembleStateDoc> {
    const state: EnsembleStateDoc = await AgentEnsembleState.findById(ensembleId);
    if (!state) {
      throw new Error('Ensemble state not found');
    }

    if (state.status !== 'active') {
      console.log(`[ensemble] Ignoring response for non-active ensemble: ${state.status}`);
      return state;
    }

    const { turnState } = state;

    if (
      response.agentType !== turnState.currentAgent?.agentType
      || (response.instanceId || 'default') !== (turnState.currentAgent?.instanceId || 'default')
    ) {
      const expected = `${turnState.currentAgent?.agentType}:${turnState.currentAgent?.instanceId || 'default'}`;
      const received = `${response.agentType}:${response.instanceId || 'default'}`;
      throw new Error(`Wrong agent responded. Expected ${expected}, got ${received}`);
    }

    if (state.lastProcessedMessageId === response.messageId) {
      console.log(
        `[ensemble] Duplicate response from ${response.agentType}:${response.instanceId || 'default'} ignored`,
      );
      return state;
    }

    const normalizedContent = (response.content || '').trim();
    const isNoReply = normalizedContent === 'NO_REPLY';

    state.stats.lastActivityAt = new Date();
    turnState.waitingForResponse = false;

    if (!isNoReply) {
      state.stats.totalMessages += 1;

      if (!state.checkpoint) {
        state.checkpoint = { recentHistory: [] };
      }
      state.checkpoint.recentHistory.push({
        agentType: turnState.currentAgent.agentType,
        instanceId: turnState.currentAgent.instanceId,
        content: (response.content || '').substring(0, 500),
        timestamp: new Date(),
      });

      if (state.checkpoint.recentHistory.length > 10) {
        state.checkpoint.recentHistory = state.checkpoint.recentHistory.slice(-10);
      }

      state.lastProcessedMessageId = response.messageId;
      state.checkpoint.lastMessageId = response.messageId;
      state.checkpoint.savedAt = new Date();
    }

    const stopReason = AgentEnsembleService.checkStopConditions(state);
    if (stopReason) {
      await AgentEnsembleService.completeDiscussion(state._id.toString(), stopReason);
      return state;
    }

    state.advanceTurn();
    await state.save();
    await AgentEnsembleService.enqueueTurnEvent(state);
    return state;
  }

  static checkStopConditions(state: EnsembleStateDoc): string | null {
    const { stopConditions, stats, turnState } = state;

    if (stats.totalMessages >= stopConditions.maxMessages) {
      return 'max_messages';
    }
    if (turnState.roundNumber >= stopConditions.maxRounds) {
      return 'max_rounds';
    }
    if (stopConditions.maxDurationMinutes > 0 && stats.startedAt) {
      const elapsed = (Date.now() - stats.startedAt.getTime()) / 1000 / 60;
      if (elapsed >= stopConditions.maxDurationMinutes) {
        return 'max_duration';
      }
    }
    return null;
  }

  static async pauseDiscussion(podId: string): Promise<EnsembleStateDoc> {
    const activeStates: EnsembleStateDoc[] = await AgentEnsembleState.find({
      podId,
      status: 'active',
    }).sort({ createdAt: -1 });

    if (!activeStates.length) {
      throw new Error('No active discussion found');
    }

    const pausedAt = new Date();
    await AgentEnsembleState.updateMany(
      { podId, status: 'active' },
      { $set: { status: 'paused', 'stats.pausedAt': pausedAt } },
    );

    const state = activeStates[0];
    state.status = 'paused';
    state.stats.pausedAt = pausedAt;
    console.log(`[ensemble] Paused discussion in pod ${podId}`);
    return state;
  }

  static async resumeDiscussion(podId: string): Promise<EnsembleStateDoc> {
    const state: EnsembleStateDoc = await AgentEnsembleState.findOne({
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
    await AgentEnsembleService.enqueueTurnEvent(state);
    console.log(`[ensemble] Resumed discussion in pod ${podId} at turn ${state.turnState.turnNumber}`);
    return state;
  }

  static async completeDiscussion(ensembleId: string, reason = 'manual'): Promise<EnsembleStateDoc> {
    const state: EnsembleStateDoc = await AgentEnsembleState.findById(ensembleId);
    if (!state) {
      throw new Error('Ensemble state not found');
    }

    state.status = 'completed';
    state.stats.completedAt = new Date();
    state.stats.completionReason = reason;

    if (state.keyPoints?.length) {
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

  static async completeActiveForPod(podId: string, reason = 'manual'): Promise<EnsembleStateDoc> {
    const states: EnsembleStateDoc[] = await AgentEnsembleState.find({
      podId,
      status: { $in: ['active', 'paused'] },
    }).sort({ createdAt: -1 });

    if (!states.length) {
      throw new Error('No active discussion to complete');
    }

    const completedStates = await Promise.all(states.map(async (state) => {
      state.status = 'completed';
      state.stats.completedAt = new Date();
      state.stats.completionReason = reason;

      if (state.keyPoints?.length) {
        state.summary = {
          keyInsights: state.keyPoints.map((kp) => kp.content),
          generatedAt: new Date(),
        };
      }

      await state.save();
      return state;
    }));

    console.log(`[ensemble] Completed ${completedStates.length} discussions in pod ${podId}: ${reason}`);
    return completedStates[0];
  }

  static async getState(podId: string): Promise<EnsembleStateDoc | null> {
    const activeStates: EnsembleStateDoc[] = await AgentEnsembleState.find({
      podId,
      status: { $in: ['active', 'paused'] },
    }).sort({ createdAt: -1 });

    const state = activeStates[0];

    if (activeStates.length > 1) {
      await Promise.all(
        activeStates.slice(1).map(async (older) => {
          older.status = 'completed';
          older.stats.completedAt = new Date();
          older.stats.completionReason = 'scheduled_restart';
          await older.save();
        }),
      );
    }

    if (state) {
      return state;
    }

    return AgentEnsembleState.findOne({ podId })
      .sort({ createdAt: -1 })
      .lean() as Promise<EnsembleStateDoc | null>;
  }

  static async updateConfig(podId: string, config: UpdateConfigOptions): Promise<unknown> {
    if (config.participants) {
      const speakingCount = config.participants.filter((p) => p.role !== 'observer').length;
      if (speakingCount < 2) {
        throw new Error('At least 2 speaking participants required for ensemble discussion');
      }
    }

    const state: EnsembleStateDoc | null = await AgentEnsembleState.findOne({
      podId,
      status: { $in: ['active', 'pending', 'paused'] },
    }).sort({ createdAt: -1 });

    if (state) {
      if (state.status === 'active' && config.participants) {
        const currentCount = state.participants?.length || 0;
        const newCount = config.participants?.length || 0;

        if (newCount < currentCount) {
          throw new Error(
            'Cannot remove participants during active discussion. Please stop the discussion first.',
          );
        }

        const existingChanged = config.participants.slice(0, currentCount).some((p, i) => {
          const current = state.participants[i];
          return (
            p.agentType !== current.agentType
            || (p.instanceId || 'default') !== (current.instanceId || 'default')
          );
        });

        if (existingChanged) {
          throw new Error('Cannot modify existing participant identities during active discussion');
        }

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
      if (config.participants) {
        state.participants = config.participants;
      }
      if (config.stopConditions) {
        state.stopConditions = { ...state.stopConditions, ...config.stopConditions } as Required<StopConditions>;
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
      const existing = pod.agentEnsemble?.toObject ? pod.agentEnsemble.toObject() : (pod.agentEnsemble || {});
      const cleanExisting = Object.fromEntries(Object.entries(existing as Record<string, unknown>).filter(([, v]) => v !== undefined));
      pod.agentEnsemble = { ...cleanExisting, ...config };
      await pod.save();
      if (!state) {
        const scheduleConfig: ScheduleConfig = config.schedule || pod.agentEnsemble?.schedule || {};
        const participants: ParticipantConfig[] = config.participants || pod.agentEnsemble?.participants || [];
        if (scheduleConfig.enabled && participants.length >= 2) {
          const nextScheduledAt = AgentEnsembleService.resolveNextScheduledAt(scheduleConfig);
          const existingScheduled: EnsembleStateDoc | null = await AgentEnsembleState.findOne({
            podId,
            status: 'completed',
            'schedule.enabled': true,
          }).sort({ 'schedule.nextScheduledAt': -1, createdAt: -1 });

          if (existingScheduled) {
            existingScheduled.status = 'pending';
            existingScheduled.topic = config.topic || pod.agentEnsemble?.topic || 'Open discussion';
            existingScheduled.participants = participants;
            existingScheduled.stopConditions = {
              maxMessages: config.stopConditions?.maxMessages || pod.agentEnsemble?.stopConditions?.maxMessages || 20,
              maxRounds: config.stopConditions?.maxRounds || pod.agentEnsemble?.stopConditions?.maxRounds || 5,
              maxDurationMinutes: config.stopConditions?.maxDurationMinutes
                || pod.agentEnsemble?.stopConditions?.maxDurationMinutes || 60,
            };
            existingScheduled.schedule = {
              enabled: Boolean(scheduleConfig.enabled),
              cronExpression: scheduleConfig.cronExpression,
              timezone: scheduleConfig.timezone || 'UTC',
              lastScheduledAt: null,
              nextScheduledAt,
            };
            await existingScheduled.save();
            return existingScheduled;
          }

          const pendingState: EnsembleStateDoc = await AgentEnsembleState.create({
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

  static async resumeAllPaused(): Promise<void> {
    const pausedStates: EnsembleStateDoc[] = await AgentEnsembleState.findPausedForResume();
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
          const e = err as { message?: string };
          console.error(`[ensemble] Failed to resume pod ${state.podId}:`, e.message);
        }
      }),
    );
  }

  static async processScheduled(): Promise<void> {
    const dueStates: EnsembleStateDoc[] = await AgentEnsembleState.findScheduledDue().sort({ createdAt: -1 });
    const seenPods = new Set<string>();
    const duplicates: unknown[] = [];
    const scheduledStates: EnsembleStateDoc[] = [];

    dueStates.forEach((state) => {
      const podKey = String(state.podId);
      if (seenPods.has(podKey)) {
        duplicates.push(state._id);
      } else {
        seenPods.add(podKey);
        scheduledStates.push(state);
      }
    });

    if (duplicates.length) {
      const completedAt = new Date();
      await AgentEnsembleState.updateMany(
        { _id: { $in: duplicates } },
        {
          $set: {
            status: 'completed',
            'schedule.enabled': false,
            'stats.completedAt': completedAt,
            'stats.completionReason': 'scheduled_restart',
          },
        },
      );
      console.warn(`[ensemble] Deduped ${duplicates.length} scheduled states`);
    }

    console.log(`[ensemble] Found ${scheduledStates.length} scheduled discussions to start`);

    await Promise.allSettled(
      scheduledStates.map(async (state) => {
        try {
          if (state.status === 'completed' && state.schedule?.nextScheduledAt) {
            return;
          }

          const paused: EnsembleStateDoc | null = await AgentEnsembleState.findOne({
            podId: state.podId,
            status: 'paused',
          }).sort({ createdAt: -1 });
          if (paused) {
            console.log(`[ensemble] Skipping scheduled start because discussion is paused in pod ${state.podId}`);
            return;
          }

          const existing: EnsembleStateDoc | null = await AgentEnsembleState.findActiveForPod(state.podId);
          if (existing) {
            console.log(`[ensemble] Auto-completing active discussion before starting scheduled one in pod ${state.podId}`);
            await AgentEnsembleService.completeActiveForPod(String(state.podId), 'scheduled_restart');
          }

          await AgentEnsembleService.startDiscussion(String(state.podId), {
            topic: state.topic,
            participants: state.participants,
          });

          if (state.schedule) {
            state.schedule.lastScheduledAt = new Date();
            state.schedule.nextScheduledAt = AgentEnsembleService.resolveNextScheduledAt(state.schedule);
          }
          await state.save();
        } catch (err) {
          const e = err as { message?: string };
          console.error('[ensemble] Failed to start scheduled discussion:', e.message);
        }
      }),
    );
  }
}

module.exports = AgentEnsembleService;

export {};
