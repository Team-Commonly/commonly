/**
 * PodLink Model
 *
 * Enables cross-pod federation with explicit, auditable permissions.
 * Pods can share summaries, skills, and assets with other pods.
 */

const mongoose = require('mongoose');

const ScopeSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: [
        'summaries:read',
        'skills:read',
        'assets:read',
        'memory:read',
        'context:read',
      ],
    },
    filters: {
      tags: [String], // Only share items with these tags
      types: [String], // Only share these asset types
      since: Date, // Only share items since this date
    },
  },
  { _id: false },
);

const AuditLogEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: ['created', 'approved', 'revoked', 'query', 'scope_changed'],
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    actorType: {
      type: String,
      enum: ['human', 'agent', 'system'],
      default: 'human',
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    details: mongoose.Schema.Types.Mixed,
  },
  { _id: false },
);

const PodLinkSchema = new mongoose.Schema(
  {
    // Source pod (the one granting access)
    sourcePodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
    },

    // Target pod (the one receiving access)
    targetPodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
    },

    // What the target pod can access from source
    scopes: {
      type: [ScopeSchema],
      required: true,
      validate: [(v) => v.length > 0, 'At least one scope is required'],
    },

    // Link status
    status: {
      type: String,
      enum: ['pending', 'active', 'revoked', 'expired'],
      default: 'pending',
    },

    // Who requested the link (from target pod)
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Who approved the link (from source pod)
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // Optional expiration
    expiresAt: Date,

    // Usage statistics
    usage: {
      queryCount: { type: Number, default: 0 },
      lastQueryAt: Date,
      totalItemsAccessed: { type: Number, default: 0 },
    },

    // Audit trail
    auditLog: [AuditLogEntrySchema],

    // Optional message/reason for the link
    message: String,
  },
  {
    timestamps: true,
  },
);

// Indexes
PodLinkSchema.index({ sourcePodId: 1, targetPodId: 1 }, { unique: true });
PodLinkSchema.index({ sourcePodId: 1, status: 1 });
PodLinkSchema.index({ targetPodId: 1, status: 1 });
PodLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

// Static methods
PodLinkSchema.statics.findActiveLink = function (sourcePodId, targetPodId) {
  return this.findOne({
    sourcePodId,
    targetPodId,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
};

PodLinkSchema.statics.getLinksForPod = function (podId, direction = 'both') {
  const query = { status: 'active' };

  if (direction === 'outgoing') {
    query.sourcePodId = podId;
  } else if (direction === 'incoming') {
    query.targetPodId = podId;
  } else {
    query.$or = [{ sourcePodId: podId }, { targetPodId: podId }];
  }

  return this.find(query)
    .populate('sourcePodId', 'name type')
    .populate('targetPodId', 'name type')
    .lean();
};

PodLinkSchema.statics.getPendingRequests = function (podId) {
  return this.find({
    sourcePodId: podId,
    status: 'pending',
  })
    .populate('targetPodId', 'name type')
    .populate('requestedBy', 'username')
    .lean();
};

PodLinkSchema.statics.requestLink = async function (options) {
  const {
    sourcePodId, targetPodId, scopes, requestedBy, message,
  } = options;

  // Check if link already exists
  const existing = await this.findOne({ sourcePodId, targetPodId });
  if (existing) {
    if (existing.status === 'active') {
      throw new Error('Link already exists');
    }
    if (existing.status === 'pending') {
      throw new Error('Link request already pending');
    }
    // Reactivate revoked link
    existing.status = 'pending';
    existing.scopes = scopes;
    existing.requestedBy = requestedBy;
    existing.message = message;
    existing.auditLog.push({
      action: 'created',
      actorId: requestedBy,
      details: { scopes, message },
    });
    return existing.save();
  }

  return this.create({
    sourcePodId,
    targetPodId,
    scopes,
    requestedBy,
    message,
    auditLog: [
      {
        action: 'created',
        actorId: requestedBy,
        details: { scopes, message },
      },
    ],
  });
};

// Instance methods
PodLinkSchema.methods.approve = async function (userId) {
  if (this.status !== 'pending') {
    throw new Error('Can only approve pending links');
  }

  this.status = 'active';
  this.approvedBy = userId;
  this.auditLog.push({
    action: 'approved',
    actorId: userId,
    timestamp: new Date(),
  });

  return this.save();
};

PodLinkSchema.methods.revoke = async function (userId, reason) {
  if (this.status !== 'active') {
    throw new Error('Can only revoke active links');
  }

  this.status = 'revoked';
  this.auditLog.push({
    action: 'revoked',
    actorId: userId,
    timestamp: new Date(),
    details: { reason },
  });

  return this.save();
};

PodLinkSchema.methods.recordQuery = async function (actorId, actorType, details) {
  this.usage.queryCount += 1;
  this.usage.lastQueryAt = new Date();
  this.usage.totalItemsAccessed += details.itemCount || 0;

  this.auditLog.push({
    action: 'query',
    actorId,
    actorType,
    timestamp: new Date(),
    details,
  });

  // Keep only last 100 audit entries
  if (this.auditLog.length > 100) {
    this.auditLog = this.auditLog.slice(-100);
  }

  return this.save();
};

PodLinkSchema.methods.hasScope = function (scopeType, filters = {}) {
  return this.scopes.some((scope) => {
    if (scope.type !== scopeType) return false;

    // Check filters
    if (scope.filters?.tags?.length > 0 && filters.tags) {
      const hasMatchingTag = filters.tags.some((t) => scope.filters.tags.includes(t));
      if (!hasMatchingTag) return false;
    }

    if (scope.filters?.types?.length > 0 && filters.type) {
      if (!scope.filters.types.includes(filters.type)) return false;
    }

    if (scope.filters?.since && filters.createdAt) {
      if (new Date(filters.createdAt) < scope.filters.since) return false;
    }

    return true;
  });
};

module.exports = mongoose.model('PodLink', PodLinkSchema);
