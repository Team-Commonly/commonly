const mongoose = require('mongoose');

/**
 * Agent Ensemble State Model
 *
 * Stores the state of agent ensemble discussions (AEP pods) for:
 * - Resume capability after container restarts
 * - Turn state and checkpoint tracking
 * - Discussion context and history preservation
 */
const AgentEnsembleStateSchema = new mongoose.Schema(
  {
    // Reference to the pod running the ensemble
    podId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
      index: true,
    },

    // ID of the last successfully processed response message to prevent duplicates
    lastProcessedMessageId: {
      type: String,
      default: null,
    },

    // Current discussion status
    status: {
      type: String,
      enum: ['pending', 'active', 'paused', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },

    // Discussion topic/prompt
    topic: {
      type: String,
      required: true,
    },

    // Participating agents in order
    participants: [
      {
        agentType: {
          type: String,
          required: true,
        },
        instanceId: {
          type: String,
          default: 'default',
        },
        displayName: String,
        role: {
          type: String,
          enum: ['starter', 'responder', 'synthesizer', 'observer'],
          default: 'responder',
        },
      },
    ],

    // Current turn state
    turnState: {
      // Which agent's turn it currently is
      currentAgent: {
        agentType: String,
        instanceId: String,
      },
      // Current turn number (0-indexed)
      turnNumber: {
        type: Number,
        default: 0,
      },
      // Total rounds completed (a round = all agents have spoken once)
      roundNumber: {
        type: Number,
        default: 0,
      },
      // When the current turn started
      turnStartedAt: Date,
      // Whether waiting for agent response
      waitingForResponse: {
        type: Boolean,
        default: false,
      },
      // Timestamp of the last response received for the current turn
      lastResponseTime: {
        type: Date,
        default: null,
      },
      // Count of consecutive response timeouts
      responseTimeouts: {
        type: Number,
        default: 0,
      },
    },

    // Stop conditions
    stopConditions: {
      maxMessages: {
        type: Number,
        default: 20,
      },
      maxRounds: {
        type: Number,
        default: 5,
      },
      maxDurationMinutes: {
        type: Number,
        default: 60,
      },
      stopOnConsensus: {
        type: Boolean,
        default: false,
      },
      stopKeywords: [String],
    },

    // Discussion statistics
    stats: {
      totalMessages: {
        type: Number,
        default: 0,
      },
      startedAt: Date,
      completedAt: Date,
      pausedAt: Date,
      lastActivityAt: Date,
      completionReason: {
        type: String,
        enum: [
          'max_messages',
          'max_rounds',
          'max_duration',
          'consensus',
          'keyword',
          'manual',
          'error',
        ],
      },
    },

    // Key points extracted during discussion
    keyPoints: [
      {
        content: String,
        agentType: String,
        turnNumber: Number,
        extractedAt: Date,
      },
    ],

    // Checkpoint data for resume
    checkpoint: {
      // Last processed message ID
      lastMessageId: String,
      // Context snapshot for resume
      contextSnapshot: {
        type: mongoose.Schema.Types.Mixed,
      },
      // Conversation history for context window
      recentHistory: [
        {
          agentType: String,
          content: String,
          timestamp: Date,
        },
      ],
      savedAt: Date,
    },

    // Final summary when discussion completes
    summary: {
      content: String,
      keyInsights: [String],
      generatedBy: String,
      generatedAt: Date,
    },

    // Schedule configuration (for recurring discussions)
    schedule: {
      enabled: {
        type: Boolean,
        default: false,
      },
      // Cron expression (e.g., "0 */20 * * *" for every 20 minutes)
      cronExpression: String,
      // Timezone for the schedule
      timezone: {
        type: String,
        default: 'UTC',
      },
      lastScheduledAt: Date,
      nextScheduledAt: Date,
    },

    // Metadata
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true },
);

// Compound indexes for efficient queries
AgentEnsembleStateSchema.index({ podId: 1, status: 1 });
AgentEnsembleStateSchema.index({ status: 1, 'schedule.nextScheduledAt': 1 });

// Virtual for checking if discussion can continue
AgentEnsembleStateSchema.virtual('canContinue').get(function canContinue() {
  if (this.status !== 'active') return false;

  const { stopConditions, stats, turnState } = this;

  // Check max messages
  if (stats.totalMessages >= stopConditions.maxMessages) return false;

  // Check max rounds
  if (turnState.roundNumber >= stopConditions.maxRounds) return false;

  // Check max duration
  if (stopConditions.maxDurationMinutes > 0 && stats.startedAt) {
    const elapsed = (Date.now() - stats.startedAt.getTime()) / 1000 / 60;
    if (elapsed >= stopConditions.maxDurationMinutes) return false;
  }

  return true;
});

// Method to get next agent in rotation
AgentEnsembleStateSchema.methods.getNextAgent = function getNextAgent() {
  const { participants, turnState } = this;
  if (!participants || participants.length === 0) return null;

  const nextIndex = (turnState.turnNumber + 1) % participants.length;
  return participants[nextIndex];
};

// Method to advance to next turn
AgentEnsembleStateSchema.methods.advanceTurn = function advanceTurn() {
  const { turnState, participants } = this;

  turnState.turnNumber += 1;
  turnState.turnStartedAt = new Date();
  turnState.waitingForResponse = true;

  // Check if we completed a round
  if (turnState.turnNumber % participants.length === 0) {
    turnState.roundNumber += 1;
  }

  // Set current agent
  const currentIndex = turnState.turnNumber % participants.length;
  const current = participants[currentIndex];
  turnState.currentAgent = {
    agentType: current.agentType,
    instanceId: current.instanceId,
  };

  this.stats.lastActivityAt = new Date();
  return this;
};

// Method to add checkpoint
AgentEnsembleStateSchema.methods.saveCheckpoint = function saveCheckpoint(data) {
  this.checkpoint = {
    ...this.checkpoint,
    ...data,
    savedAt: new Date(),
  };
  return this;
};

// Method to complete discussion
AgentEnsembleStateSchema.methods.complete = function complete(reason, summaryContent) {
  this.status = 'completed';
  this.stats.completedAt = new Date();
  this.stats.completionReason = reason;

  if (summaryContent) {
    this.summary = {
      content: summaryContent,
      generatedAt: new Date(),
    };
  }

  return this;
};

// Static method to find active ensemble for a pod
AgentEnsembleStateSchema.statics.findActiveForPod = function findActiveForPod(podId) {
  return this.findOne({ podId, status: 'active' });
};

// Static method to find all paused ensembles for resume
AgentEnsembleStateSchema.statics.findPausedForResume = function findPausedForResume() {
  return this.find({ status: 'paused' }).sort({ 'stats.pausedAt': 1 });
};

// Static method to find scheduled ensembles due to run
AgentEnsembleStateSchema.statics.findScheduledDue = function findScheduledDue() {
  return this.find({
    status: { $in: ['pending', 'completed'] },
    'schedule.enabled': true,
    'schedule.nextScheduledAt': { $lte: new Date() },
  });
};

module.exports = mongoose.model('AgentEnsembleState', AgentEnsembleStateSchema);
