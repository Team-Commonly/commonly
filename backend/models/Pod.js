const mongoose = require('mongoose');

const PodSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ['chat', 'study', 'games', 'agent-ensemble', 'agent-admin'],
      default: 'chat',
    },
    joinPolicy: {
      type: String,
      enum: ['open', 'invite-only'],
      default: 'open',
    },
    parentPod: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      default: null,
    },
    // Agent Ensemble Pod (AEP) configuration - only used when type === 'agent-ensemble'
    agentEnsemble: {
      // Whether the ensemble is currently enabled
      enabled: {
        type: Boolean,
        default: false,
      },
      // Discussion topic/prompt for the ensemble
      topic: String,
      // Participating agents
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
          role: {
            type: String,
            enum: ['starter', 'responder', 'synthesizer', 'observer'],
            default: 'responder',
          },
        },
      ],
      // Stop conditions for discussions
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
      },
      // Schedule for recurring discussions
      schedule: {
        enabled: {
          type: Boolean,
          default: false,
        },
        frequencyMinutes: {
          type: Number,
          default: 20,
        },
        timezone: {
          type: String,
          default: 'UTC',
        },
      },
      // Whether humans can participate
      humanParticipation: {
        type: String,
        enum: ['none', 'read-only', 'participate'],
        default: 'participate',
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    messages: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message',
      },
    ],
    announcements: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Announcement',
      },
    ],
    externalLinks: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ExternalLink',
      },
    ],
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Add the creator to members automatically
PodSchema.pre('save', function (next) {
  if (this.isNew && !this.members.includes(this.createdBy)) {
    this.members.push(this.createdBy);
  }
  next();
});

module.exports = mongoose.model('Pod', PodSchema);
