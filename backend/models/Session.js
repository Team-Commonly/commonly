/**
 * Session Model
 *
 * Sessions manage agent context for pods. Each session tracks:
 * - Conversation transcript (JSONL-style)
 * - Token usage
 * - Reset policies
 * - Compaction state
 *
 * Session keys follow the pattern: pod:<podId>:user:<userId>
 * or pod:<podId>:agent:<agentId> for agent-specific sessions.
 */

const mongoose = require('mongoose');

const TranscriptEntrySchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['user', 'assistant', 'system', 'tool'],
      required: true,
    },
    content: {
      type: mongoose.Schema.Types.Mixed, // String or structured object
      required: true,
    },
    name: String, // For tool calls
    toolCallId: String, // For tool results
    timestamp: {
      type: Date,
      default: Date.now,
    },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
    },
  },
  { _id: false },
);

const ResetPolicySchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ['daily', 'idle', 'never'],
      default: 'idle',
    },
    atHour: {
      type: Number, // For daily mode: hour in UTC (0-23)
      min: 0,
      max: 23,
    },
    idleMinutes: {
      type: Number, // For idle mode: minutes of inactivity
      default: 120,
    },
  },
  { _id: false },
);

const TokenUsageSchema = new mongoose.Schema(
  {
    input: { type: Number, default: 0 },
    output: { type: Number, default: 0 },
    context: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false },
);

const SessionSchema = new mongoose.Schema(
  {
    // Composite key: pod:<podId>:user:<userId> or pod:<podId>:agent:<agentId>
    sessionKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Pod boundary (required)
    podId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
      index: true,
    },

    // User if this is a user session
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },

    // Agent if this is an agent session
    agentId: {
      type: String,
      index: true,
    },

    // Integration source if from external platform
    source: {
      type: String, // discord, slack, telegram, etc.
    },

    // Conversation transcript
    transcript: [TranscriptEntrySchema],

    // Token usage tracking
    tokenUsage: {
      type: TokenUsageSchema,
      default: () => ({}),
    },

    // Compaction tracking
    compaction: {
      lastCompactedAt: Date,
      compactionCount: { type: Number, default: 0 },
      lastFlushAt: Date, // For memory flush before compaction
    },

    // Reset policy
    resetPolicy: {
      type: ResetPolicySchema,
      default: () => ({}),
    },

    // Session state
    state: {
      type: String,
      enum: ['active', 'compacting', 'resetting', 'archived'],
      default: 'active',
    },

    // Last activity
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },

    // Context window settings
    contextSettings: {
      maxTokens: { type: Number, default: 8000 },
      compactionThreshold: { type: Number, default: 6000 },
      includeMemory: { type: Boolean, default: true },
      includeSkills: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for efficient queries
SessionSchema.index({ podId: 1, userId: 1 });
SessionSchema.index({ podId: 1, agentId: 1 });
SessionSchema.index({ lastActivityAt: 1 });
SessionSchema.index({ 'resetPolicy.mode': 1, lastActivityAt: 1 });

// Static methods
SessionSchema.statics.findByKey = function (sessionKey) {
  return this.findOne({ sessionKey });
};

SessionSchema.statics.findOrCreate = async function (sessionKey, defaults = {}) {
  let session = await this.findOne({ sessionKey });
  if (!session) {
    session = await this.create({ sessionKey, ...defaults });
  }
  return session;
};

SessionSchema.statics.getActiveSessions = function (podId) {
  return this.find({ podId, state: 'active' }).sort({ lastActivityAt: -1 });
};

// Instance methods
SessionSchema.methods.appendTranscript = async function (entry) {
  this.transcript.push({
    ...entry,
    timestamp: new Date(),
  });
  this.lastActivityAt = new Date();

  // Update token usage if provided
  if (entry.tokenUsage) {
    this.tokenUsage.input += entry.tokenUsage.input || 0;
    this.tokenUsage.output += entry.tokenUsage.output || 0;
    this.tokenUsage.context = entry.tokenUsage.context || this.tokenUsage.context;
    this.tokenUsage.total = this.tokenUsage.input + this.tokenUsage.output;
  }

  return this.save();
};

SessionSchema.methods.shouldCompact = function () {
  return this.tokenUsage.context >= this.contextSettings.compactionThreshold;
};

SessionSchema.methods.shouldReset = function () {
  const now = new Date();

  if (this.resetPolicy.mode === 'never') {
    return false;
  }

  if (this.resetPolicy.mode === 'daily') {
    const lastReset = this.compaction.lastCompactedAt || this.createdAt;
    const hoursSinceReset = (now - lastReset) / (1000 * 60 * 60);
    return hoursSinceReset >= 24;
  }

  if (this.resetPolicy.mode === 'idle') {
    const idleMs = now - this.lastActivityAt;
    const idleMinutes = idleMs / (1000 * 60);
    return idleMinutes >= this.resetPolicy.idleMinutes;
  }

  return false;
};

SessionSchema.methods.compact = async function (summaryContent) {
  // Replace transcript with compaction summary
  const compactionEntry = {
    role: 'system',
    content: `[Previous conversation compacted]\n\n${summaryContent}`,
    timestamp: new Date(),
    metadata: {
      type: 'compaction',
      originalLength: this.transcript.length,
      compactedAt: new Date(),
    },
  };

  this.transcript = [compactionEntry];
  this.compaction.lastCompactedAt = new Date();
  this.compaction.compactionCount += 1;
  this.tokenUsage.context = 0; // Reset context tokens

  return this.save();
};

SessionSchema.methods.reset = async function () {
  this.transcript = [];
  this.tokenUsage = {
    input: 0, output: 0, context: 0, total: 0,
  };
  this.compaction.lastCompactedAt = new Date();
  this.lastActivityAt = new Date();

  return this.save();
};

module.exports = mongoose.model('Session', SessionSchema);
