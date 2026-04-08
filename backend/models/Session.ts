import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool';
export type ResetMode = 'daily' | 'idle' | 'never';
export type SessionState = 'active' | 'compacting' | 'resetting' | 'archived';

export interface ITranscriptEntry {
  role: TranscriptRole;
  content: string | Record<string, unknown>;
  name?: string;
  toolCallId?: string;
  timestamp: Date;
  metadata?: Map<string, unknown>;
  tokenUsage?: { input?: number; output?: number; context?: number };
}

export interface ITokenUsage {
  input: number;
  output: number;
  context: number;
  total: number;
}

export interface ISession extends Document {
  sessionKey: string;
  podId: Types.ObjectId;
  userId?: Types.ObjectId;
  agentId?: string;
  source?: string;
  transcript: ITranscriptEntry[];
  tokenUsage: ITokenUsage;
  compaction: {
    lastCompactedAt?: Date;
    compactionCount: number;
    lastFlushAt?: Date;
  };
  resetPolicy: {
    mode: ResetMode;
    atHour?: number;
    idleMinutes: number;
  };
  state: SessionState;
  lastActivityAt: Date;
  contextSettings: {
    maxTokens: number;
    compactionThreshold: number;
    includeMemory: boolean;
    includeSkills: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
  appendTranscript(entry: ITranscriptEntry): Promise<ISession>;
  shouldCompact(): boolean;
  shouldReset(): boolean;
  compact(summaryContent: string): Promise<ISession>;
  reset(): Promise<ISession>;
}

export interface ISessionModel extends Model<ISession> {
  findByKey(sessionKey: string): mongoose.Query<ISession | null, ISession>;
  findOrCreate(sessionKey: string, defaults?: Partial<ISession>): Promise<ISession>;
  getActiveSessions(podId: Types.ObjectId): mongoose.Query<ISession[], ISession>;
}

const TranscriptEntrySchema = new Schema(
  {
    role: { type: String, enum: ['user', 'assistant', 'system', 'tool'], required: true },
    content: { type: Schema.Types.Mixed, required: true },
    name: String,
    toolCallId: String,
    timestamp: { type: Date, default: Date.now },
    metadata: { type: Map, of: Schema.Types.Mixed },
  },
  { _id: false },
);

const ResetPolicySchema = new Schema(
  {
    mode: { type: String, enum: ['daily', 'idle', 'never'], default: 'idle' },
    atHour: { type: Number, min: 0, max: 23 },
    idleMinutes: { type: Number, default: 120 },
  },
  { _id: false },
);

const TokenUsageSchema = new Schema(
  {
    input: { type: Number, default: 0 },
    output: { type: Number, default: 0 },
    context: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false },
);

const SessionSchema = new Schema<ISession>(
  {
    sessionKey: { type: String, required: true, unique: true, index: true },
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    agentId: { type: String, index: true },
    source: { type: String },
    transcript: [TranscriptEntrySchema],
    tokenUsage: { type: TokenUsageSchema, default: () => ({}) },
    compaction: {
      lastCompactedAt: Date,
      compactionCount: { type: Number, default: 0 },
      lastFlushAt: Date,
    },
    resetPolicy: { type: ResetPolicySchema, default: () => ({}) },
    state: {
      type: String,
      enum: ['active', 'compacting', 'resetting', 'archived'],
      default: 'active',
    },
    lastActivityAt: { type: Date, default: Date.now },
    contextSettings: {
      maxTokens: { type: Number, default: 8000 },
      compactionThreshold: { type: Number, default: 6000 },
      includeMemory: { type: Boolean, default: true },
      includeSkills: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

SessionSchema.index({ podId: 1, userId: 1 });
SessionSchema.index({ podId: 1, agentId: 1 });
SessionSchema.index({ lastActivityAt: 1 });
SessionSchema.index({ 'resetPolicy.mode': 1, lastActivityAt: 1 });

SessionSchema.statics.findByKey = function (sessionKey: string) {
  return this.findOne({ sessionKey });
};

SessionSchema.statics.findOrCreate = async function (sessionKey: string, defaults = {}) {
  let session = await this.findOne({ sessionKey });
  if (!session) {
    session = await this.create({ sessionKey, ...defaults });
  }
  return session;
};

SessionSchema.statics.getActiveSessions = function (podId: Types.ObjectId) {
  return this.find({ podId, state: 'active' }).sort({ lastActivityAt: -1 });
};

SessionSchema.methods.appendTranscript = async function (entry: ITranscriptEntry) {
  this.transcript.push({ ...entry, timestamp: new Date() });
  this.lastActivityAt = new Date();

  if (entry.tokenUsage) {
    this.tokenUsage.input += entry.tokenUsage.input || 0;
    this.tokenUsage.output += entry.tokenUsage.output || 0;
    this.tokenUsage.context = entry.tokenUsage.context || this.tokenUsage.context;
    this.tokenUsage.total = this.tokenUsage.input + this.tokenUsage.output;
  }

  return this.save();
};

SessionSchema.methods.shouldCompact = function (): boolean {
  return this.tokenUsage.context >= this.contextSettings.compactionThreshold;
};

SessionSchema.methods.shouldReset = function (): boolean {
  const now = new Date();

  if (this.resetPolicy.mode === 'never') return false;

  if (this.resetPolicy.mode === 'daily') {
    const lastReset = this.compaction.lastCompactedAt || this.createdAt;
    return (now.getTime() - lastReset.getTime()) / (1000 * 60 * 60) >= 24;
  }

  if (this.resetPolicy.mode === 'idle') {
    const idleMinutes = (now.getTime() - this.lastActivityAt.getTime()) / (1000 * 60);
    return idleMinutes >= this.resetPolicy.idleMinutes;
  }

  return false;
};

SessionSchema.methods.compact = async function (summaryContent: string) {
  this.transcript = [
    {
      role: 'system',
      content: `[Previous conversation compacted]\n\n${summaryContent}`,
      timestamp: new Date(),
      metadata: new Map<string, unknown>([
        ['type', 'compaction'],
        ['originalLength', this.transcript.length],
        ['compactedAt', new Date()],
      ]),
    },
  ];
  this.compaction.lastCompactedAt = new Date();
  this.compaction.compactionCount += 1;
  this.tokenUsage.context = 0;
  return this.save();
};

SessionSchema.methods.reset = async function () {
  this.transcript = [];
  this.tokenUsage = { input: 0, output: 0, context: 0, total: 0 };
  this.compaction.lastCompactedAt = new Date();
  this.lastActivityAt = new Date();
  return this.save();
};

export default mongoose.model<ISession, ISessionModel>('Session', SessionSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
