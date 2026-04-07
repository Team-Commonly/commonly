import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type EnsembleStatus = 'pending' | 'active' | 'paused' | 'completed' | 'failed';
export type EnsembleParticipantRole = 'starter' | 'responder' | 'synthesizer' | 'observer';
export type EnsembleCompletionReason =
  | 'max_messages'
  | 'max_rounds'
  | 'max_duration'
  | 'consensus'
  | 'keyword'
  | 'manual'
  | 'scheduled_restart'
  | 'error';

export interface IEnsembleParticipant {
  agentType: string;
  instanceId: string;
  displayName?: string;
  role: EnsembleParticipantRole;
}

export interface IKeyPoint {
  content?: string;
  agentType?: string;
  turnNumber?: number;
  extractedAt?: Date;
}

export interface IAgentEnsembleState extends Document {
  podId: Types.ObjectId;
  lastProcessedMessageId?: string | null;
  status: EnsembleStatus;
  topic: string;
  participants: IEnsembleParticipant[];
  turnState: {
    currentAgent?: { agentType?: string; instanceId?: string };
    turnNumber: number;
    roundNumber: number;
    turnStartedAt?: Date;
    waitingForResponse: boolean;
    lastResponseTime?: Date | null;
    responseTimeouts: number;
  };
  stopConditions: {
    maxMessages: number;
    maxRounds: number;
    maxDurationMinutes: number;
    stopOnConsensus: boolean;
    stopKeywords: string[];
  };
  stats: {
    totalMessages: number;
    startedAt?: Date;
    completedAt?: Date;
    pausedAt?: Date;
    lastActivityAt?: Date;
    completionReason?: EnsembleCompletionReason;
  };
  keyPoints: IKeyPoint[];
  checkpoint: {
    lastMessageId?: string;
    contextSnapshot?: unknown;
    recentHistory?: Array<{ agentType?: string; content?: string; timestamp?: Date }>;
    savedAt?: Date;
  };
  summary?: {
    content?: string;
    keyInsights?: string[];
    generatedBy?: string;
    generatedAt?: Date;
  };
  schedule: {
    enabled: boolean;
    cronExpression?: string;
    timezone: string;
    lastScheduledAt?: Date;
    nextScheduledAt?: Date;
  };
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  // virtuals
  canContinue: boolean;
  // methods
  getSpeakingParticipants(): IEnsembleParticipant[];
  getNextAgent(): IEnsembleParticipant | null;
  advanceTurn(): IAgentEnsembleState;
  saveCheckpoint(data: Partial<IAgentEnsembleState['checkpoint']>): IAgentEnsembleState;
  complete(reason: EnsembleCompletionReason, summaryContent?: string): IAgentEnsembleState;
}

export interface IAgentEnsembleStateModel extends Model<IAgentEnsembleState> {
  findActiveForPod(podId: Types.ObjectId): mongoose.Query<IAgentEnsembleState | null, IAgentEnsembleState>;
  findPausedForResume(): mongoose.Query<IAgentEnsembleState[], IAgentEnsembleState>;
  findScheduledDue(): mongoose.Query<IAgentEnsembleState[], IAgentEnsembleState>;
}

const AgentEnsembleStateSchema = new Schema<IAgentEnsembleState>(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true, index: true },
    lastProcessedMessageId: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'active', 'paused', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    topic: { type: String, required: true },
    participants: [
      {
        agentType: { type: String, required: true },
        instanceId: { type: String, default: 'default' },
        displayName: String,
        role: { type: String, enum: ['starter', 'responder', 'synthesizer', 'observer'], default: 'responder' },
      },
    ],
    turnState: {
      currentAgent: { agentType: String, instanceId: String },
      turnNumber: { type: Number, default: 0 },
      roundNumber: { type: Number, default: 0 },
      turnStartedAt: Date,
      waitingForResponse: { type: Boolean, default: false },
      lastResponseTime: { type: Date, default: null },
      responseTimeouts: { type: Number, default: 0 },
    },
    stopConditions: {
      maxMessages: { type: Number, default: 20 },
      maxRounds: { type: Number, default: 5 },
      maxDurationMinutes: { type: Number, default: 60 },
      stopOnConsensus: { type: Boolean, default: false },
      stopKeywords: [String],
    },
    stats: {
      totalMessages: { type: Number, default: 0 },
      startedAt: Date,
      completedAt: Date,
      pausedAt: Date,
      lastActivityAt: Date,
      completionReason: {
        type: String,
        enum: ['max_messages', 'max_rounds', 'max_duration', 'consensus', 'keyword', 'manual', 'scheduled_restart', 'error'],
      },
    },
    keyPoints: [
      {
        content: String,
        agentType: String,
        turnNumber: Number,
        extractedAt: Date,
      },
    ],
    checkpoint: {
      lastMessageId: String,
      contextSnapshot: { type: Schema.Types.Mixed },
      recentHistory: [{ agentType: String, content: String, timestamp: Date }],
      savedAt: Date,
    },
    summary: {
      content: String,
      keyInsights: [String],
      generatedBy: String,
      generatedAt: Date,
    },
    schedule: {
      enabled: { type: Boolean, default: false },
      cronExpression: String,
      timezone: { type: String, default: 'UTC' },
      lastScheduledAt: Date,
      nextScheduledAt: Date,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

AgentEnsembleStateSchema.index({ podId: 1, status: 1 });
AgentEnsembleStateSchema.index({ status: 1, 'schedule.nextScheduledAt': 1 });

AgentEnsembleStateSchema.virtual('canContinue').get(function (this: IAgentEnsembleState) {
  if (this.status !== 'active') return false;
  const { stopConditions, stats, turnState } = this;
  if (stats.totalMessages >= stopConditions.maxMessages) return false;
  if (turnState.roundNumber >= stopConditions.maxRounds) return false;
  if (stopConditions.maxDurationMinutes > 0 && stats.startedAt) {
    const elapsed = (Date.now() - stats.startedAt.getTime()) / 1000 / 60;
    if (elapsed >= stopConditions.maxDurationMinutes) return false;
  }
  return true;
});

AgentEnsembleStateSchema.methods.getSpeakingParticipants = function (): IEnsembleParticipant[] {
  return (this.participants || []).filter((p: IEnsembleParticipant) => p.role !== 'observer');
};

AgentEnsembleStateSchema.methods.getNextAgent = function (): IEnsembleParticipant | null {
  const speaking = this.getSpeakingParticipants();
  if (!speaking.length) return null;
  const nextIndex = (this.turnState.turnNumber + 1) % speaking.length;
  return speaking[nextIndex];
};

AgentEnsembleStateSchema.methods.advanceTurn = function () {
  const { turnState } = this;
  const speaking = this.getSpeakingParticipants();
  if (!speaking.length) { turnState.waitingForResponse = false; return this; }

  turnState.turnNumber += 1;
  turnState.turnStartedAt = new Date();
  turnState.waitingForResponse = true;

  if (turnState.turnNumber % speaking.length === 0) turnState.roundNumber += 1;

  const current = speaking[turnState.turnNumber % speaking.length];
  turnState.currentAgent = { agentType: current.agentType, instanceId: current.instanceId };
  this.stats.lastActivityAt = new Date();
  return this;
};

AgentEnsembleStateSchema.methods.saveCheckpoint = function (data: Partial<IAgentEnsembleState['checkpoint']>) {
  this.checkpoint = { ...this.checkpoint, ...data, savedAt: new Date() };
  return this;
};

AgentEnsembleStateSchema.methods.complete = function (reason: EnsembleCompletionReason, summaryContent?: string) {
  this.status = 'completed';
  this.stats.completedAt = new Date();
  this.stats.completionReason = reason;
  if (summaryContent) this.summary = { content: summaryContent, generatedAt: new Date() };
  return this;
};

AgentEnsembleStateSchema.statics.findActiveForPod = function (podId: Types.ObjectId) {
  return this.findOne({ podId, status: 'active' }).sort({ createdAt: -1 });
};

AgentEnsembleStateSchema.statics.findPausedForResume = function () {
  return this.find({ status: 'paused' }).sort({ 'stats.pausedAt': 1 });
};

AgentEnsembleStateSchema.statics.findScheduledDue = function () {
  return this.find({
    status: { $in: ['pending', 'completed'] },
    'schedule.enabled': true,
    'schedule.nextScheduledAt': { $lte: new Date() },
  });
};

export default mongoose.model<IAgentEnsembleState, IAgentEnsembleStateModel>('AgentEnsembleState', AgentEnsembleStateSchema);
