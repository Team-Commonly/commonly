/**
 * Activity Model
 *
 * Stores activity feed items with reactions, replies, and metadata.
 * Activities can be:
 * - message: Regular chat message
 * - skill_created: AI-generated skill/summary
 * - approval_needed: Pending approval request
 * - agent_action: Agent performed an action
 * - pod_event: Pod join/leave/link events
 */

const mongoose = require('mongoose');

const replySchema = new mongoose.Schema({
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  actorName: String,
  actorType: {
    type: String,
    enum: ['human', 'agent'],
    default: 'human',
  },
  content: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const activitySchema = new mongoose.Schema(
  {
    // Activity type
    type: {
      type: String,
      enum: ['message', 'skill_created', 'approval_needed', 'agent_action', 'pod_event'],
      required: true,
    },

    // Actor (who performed the action)
    actor: {
      id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      name: String,
      type: {
        type: String,
        enum: ['human', 'agent', 'system'],
        default: 'human',
      },
      verified: {
        type: Boolean,
        default: false,
      },
    },

    // Action verb
    action: {
      type: String,
      required: true,
    },

    // Main content
    content: String,

    // Associated pod
    podId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      index: true,
    },

    // Reference to source document (message, summary, etc.)
    sourceType: {
      type: String,
      enum: ['message', 'summary', 'approval', 'event'],
    },
    sourceId: String,

    // For skill_created activities
    target: {
      title: String,
      description: String,
      url: String,
    },

    // For approval_needed activities
    approval: {
      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
      },
      requestedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      requestedScopes: [String],
      reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      reviewedAt: Date,
      reviewNotes: String,
    },

    // Agent metadata
    agentMetadata: {
      agentName: String,
      sources: [
        {
          title: String,
          url: String,
        },
      ],
      confidence: Number,
      processingTime: Number,
    },

    // Mentioned/involved entities
    involves: [
      {
        id: mongoose.Schema.Types.ObjectId,
        name: String,
        type: {
          type: String,
          enum: ['human', 'agent'],
        },
      },
    ],

    // Reactions
    reactions: {
      likes: {
        type: Number,
        default: 0,
      },
      likedBy: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
      ],
    },

    // Replies
    replies: [replySchema],
    replyCount: {
      type: Number,
      default: 0,
    },

    // Visibility
    visibility: {
      type: String,
      enum: ['public', 'pod', 'private'],
      default: 'pod',
    },

    // Soft delete
    deleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for efficient querying
activitySchema.index({ podId: 1, createdAt: -1 });
activitySchema.index({ 'actor.id': 1, createdAt: -1 });
activitySchema.index({ type: 1, createdAt: -1 });
activitySchema.index({ 'approval.status': 1 }, { sparse: true });

// Static methods
activitySchema.statics.createFromMessage = async function (message, pod, user) {
  const isAgent = user.username?.toLowerCase().includes('bot')
    || user.username?.toLowerCase() === 'moltbot';

  return this.create({
    type: 'message',
    actor: {
      id: user._id,
      name: user.username,
      type: isAgent ? 'agent' : 'human',
      verified: user.verified || isAgent,
    },
    action: 'message',
    content: message.content,
    podId: pod._id,
    sourceType: 'message',
    sourceId: message._id?.toString() || message.id,
  });
};

activitySchema.statics.createSkillActivity = async function (summary, pod) {
  return this.create({
    type: 'skill_created',
    actor: {
      id: null,
      name: 'commonly-bot',
      type: 'agent',
      verified: true,
    },
    action: 'skill_created',
    content: summary.content,
    podId: pod._id,
    sourceType: 'summary',
    sourceId: summary._id?.toString(),
    target: {
      title: `${pod.name} Insights`,
      description: summary.content?.substring(0, 150),
    },
    agentMetadata: {
      agentName: 'commonly-bot',
      sources: summary.metadata?.sources || [],
    },
  });
};

activitySchema.statics.createApprovalRequest = async function (options) {
  const {
    podId, requestedBy, agentName, scopes, content,
  } = options;

  return this.create({
    type: 'approval_needed',
    actor: {
      id: null,
      name: 'commonly-bot',
      type: 'system',
      verified: true,
    },
    action: 'approval_needed',
    content: content || `Agent "${agentName}" is requesting access`,
    podId,
    approval: {
      status: 'pending',
      requestedBy,
      requestedScopes: scopes,
    },
    agentMetadata: {
      agentName,
    },
  });
};

activitySchema.statics.getFeedForUser = async function (userId, pods, options = {}) {
  const {
    limit = 20, before, filter, includeDeleted = false,
  } = options;

  const query = {
    podId: { $in: pods.map((p) => p._id) },
  };

  if (!includeDeleted) {
    query.deleted = { $ne: true };
  }

  if (before) {
    query.createdAt = { $lt: new Date(before) };
  }

  if (filter && filter !== 'all') {
    if (filter === 'humans') {
      query['actor.type'] = 'human';
    } else if (filter === 'agents') {
      query['actor.type'] = { $in: ['agent', 'system'] };
    } else if (filter === 'skills') {
      query.type = 'skill_created';
    }
  }

  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('podId', 'name type')
    .lean();
};

activitySchema.statics.getPendingApprovals = async function (podIds) {
  return this.find({
    podId: { $in: podIds },
    type: 'approval_needed',
    'approval.status': 'pending',
    deleted: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .lean();
};

// Instance methods
activitySchema.methods.addReply = async function (userId, userName, content, isAgent = false) {
  this.replies.push({
    actorId: userId,
    actorName: userName,
    actorType: isAgent ? 'agent' : 'human',
    content,
  });
  this.replyCount = this.replies.length;
  return this.save();
};

activitySchema.methods.toggleLike = async function (userId) {
  const userIdStr = userId.toString();
  const likedIndex = this.reactions.likedBy.findIndex(
    (id) => id.toString() === userIdStr,
  );

  if (likedIndex > -1) {
    this.reactions.likedBy.splice(likedIndex, 1);
    this.reactions.likes = Math.max(0, this.reactions.likes - 1);
  } else {
    this.reactions.likedBy.push(userId);
    this.reactions.likes += 1;
  }

  await this.save();
  return likedIndex === -1; // Returns true if liked, false if unliked
};

activitySchema.methods.approve = async function (userId, notes) {
  this.approval.status = 'approved';
  this.approval.reviewedBy = userId;
  this.approval.reviewedAt = new Date();
  this.approval.reviewNotes = notes;
  return this.save();
};

activitySchema.methods.reject = async function (userId, notes) {
  this.approval.status = 'rejected';
  this.approval.reviewedBy = userId;
  this.approval.reviewedAt = new Date();
  this.approval.reviewNotes = notes;
  return this.save();
};

const Activity = mongoose.model('Activity', activitySchema);

module.exports = Activity;
