import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type PodLinkScopeType =
  | 'summaries:read'
  | 'skills:read'
  | 'assets:read'
  | 'memory:read'
  | 'context:read';

export type PodLinkStatus = 'pending' | 'active' | 'revoked' | 'expired';
export type AuditActorType = 'human' | 'agent' | 'system';
export type AuditAction = 'created' | 'approved' | 'revoked' | 'query' | 'scope_changed';
export type PodLinkDirection = 'incoming' | 'outgoing' | 'both';

export interface IPodLinkScope {
  type: PodLinkScopeType;
  filters: {
    tags?: string[];
    types?: string[];
    since?: Date;
  };
}

export interface IAuditLogEntry {
  action: AuditAction;
  actorId?: Types.ObjectId;
  actorType: AuditActorType;
  timestamp: Date;
  details?: unknown;
}

export interface IPodLink extends Document {
  sourcePodId: Types.ObjectId;
  targetPodId: Types.ObjectId;
  scopes: IPodLinkScope[];
  status: PodLinkStatus;
  requestedBy: Types.ObjectId;
  approvedBy?: Types.ObjectId;
  expiresAt?: Date;
  usage: {
    queryCount: number;
    lastQueryAt?: Date;
    totalItemsAccessed: number;
  };
  auditLog: IAuditLogEntry[];
  message?: string;
  createdAt: Date;
  updatedAt: Date;
  approve(userId: Types.ObjectId): Promise<IPodLink>;
  revoke(userId: Types.ObjectId, reason?: string): Promise<IPodLink>;
  recordQuery(actorId: Types.ObjectId, actorType: AuditActorType, details: { itemCount?: number; [key: string]: unknown }): Promise<IPodLink>;
  hasScope(scopeType: PodLinkScopeType, filters?: { tags?: string[]; type?: string; createdAt?: Date }): boolean;
}

export interface IPodLinkModel extends Model<IPodLink> {
  findActiveLink(sourcePodId: Types.ObjectId, targetPodId: Types.ObjectId): mongoose.Query<IPodLink | null, IPodLink>;
  getLinksForPod(podId: Types.ObjectId, direction?: PodLinkDirection): mongoose.Query<IPodLink[], IPodLink>;
  getPendingRequests(podId: Types.ObjectId): mongoose.Query<IPodLink[], IPodLink>;
  requestLink(options: {
    sourcePodId: Types.ObjectId;
    targetPodId: Types.ObjectId;
    scopes: IPodLinkScope[];
    requestedBy: Types.ObjectId;
    message?: string;
  }): Promise<IPodLink>;
}

const ScopeSchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['summaries:read', 'skills:read', 'assets:read', 'memory:read', 'context:read'],
    },
    filters: {
      tags: [String],
      types: [String],
      since: Date,
    },
  },
  { _id: false },
);

const AuditLogEntrySchema = new Schema(
  {
    action: {
      type: String,
      required: true,
      enum: ['created', 'approved', 'revoked', 'query', 'scope_changed'],
    },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorType: { type: String, enum: ['human', 'agent', 'system'], default: 'human' },
    timestamp: { type: Date, default: Date.now },
    details: Schema.Types.Mixed,
  },
  { _id: false },
);

const PodLinkSchema = new Schema<IPodLink>(
  {
    sourcePodId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    targetPodId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    scopes: {
      type: [ScopeSchema],
      required: true,
      validate: [(v: unknown[]) => v.length > 0, 'At least one scope is required'],
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'revoked', 'expired'],
      default: 'pending',
    },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    expiresAt: Date,
    usage: {
      queryCount: { type: Number, default: 0 },
      lastQueryAt: Date,
      totalItemsAccessed: { type: Number, default: 0 },
    },
    auditLog: [AuditLogEntrySchema],
    message: String,
  },
  { timestamps: true },
);

PodLinkSchema.index({ sourcePodId: 1, targetPodId: 1 }, { unique: true });
PodLinkSchema.index({ sourcePodId: 1, status: 1 });
PodLinkSchema.index({ targetPodId: 1, status: 1 });
PodLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

PodLinkSchema.statics.findActiveLink = function (sourcePodId: Types.ObjectId, targetPodId: Types.ObjectId) {
  return this.findOne({
    sourcePodId,
    targetPodId,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
};

PodLinkSchema.statics.getLinksForPod = function (podId: Types.ObjectId, direction: PodLinkDirection = 'both') {
  const query: Record<string, unknown> = { status: 'active' };
  if (direction === 'outgoing') query.sourcePodId = podId;
  else if (direction === 'incoming') query.targetPodId = podId;
  else query.$or = [{ sourcePodId: podId }, { targetPodId: podId }];
  return this.find(query)
    .populate('sourcePodId', 'name type')
    .populate('targetPodId', 'name type')
    .lean();
};

PodLinkSchema.statics.getPendingRequests = function (podId: Types.ObjectId) {
  return this.find({ sourcePodId: podId, status: 'pending' })
    .populate('targetPodId', 'name type')
    .populate('requestedBy', 'username')
    .lean();
};

PodLinkSchema.statics.requestLink = async function (options: {
  sourcePodId: Types.ObjectId;
  targetPodId: Types.ObjectId;
  scopes: IPodLinkScope[];
  requestedBy: Types.ObjectId;
  message?: string;
}) {
  const {
    sourcePodId, targetPodId, scopes, requestedBy, message,
  } = options;

  const existing = await this.findOne({ sourcePodId, targetPodId });
  if (existing) {
    if (existing.status === 'active') throw new Error('Link already exists');
    if (existing.status === 'pending') throw new Error('Link request already pending');
    existing.status = 'pending';
    existing.scopes = scopes;
    existing.requestedBy = requestedBy;
    existing.message = message;
    existing.auditLog.push({ action: 'created', actorId: requestedBy, details: { scopes, message } });
    return existing.save();
  }

  return this.create({
    sourcePodId, targetPodId, scopes, requestedBy, message,
    auditLog: [{ action: 'created', actorId: requestedBy, details: { scopes, message } }],
  });
};

PodLinkSchema.methods.approve = async function (userId: Types.ObjectId) {
  if (this.status !== 'pending') throw new Error('Can only approve pending links');
  this.status = 'active';
  this.approvedBy = userId;
  this.auditLog.push({ action: 'approved', actorId: userId, timestamp: new Date() });
  return this.save();
};

PodLinkSchema.methods.revoke = async function (userId: Types.ObjectId, reason?: string) {
  if (this.status !== 'active') throw new Error('Can only revoke active links');
  this.status = 'revoked';
  this.auditLog.push({ action: 'revoked', actorId: userId, timestamp: new Date(), details: { reason } });
  return this.save();
};

PodLinkSchema.methods.recordQuery = async function (
  actorId: Types.ObjectId,
  actorType: AuditActorType,
  details: { itemCount?: number; [key: string]: unknown },
) {
  this.usage.queryCount += 1;
  this.usage.lastQueryAt = new Date();
  this.usage.totalItemsAccessed += details.itemCount || 0;
  this.auditLog.push({ action: 'query', actorId, actorType, timestamp: new Date(), details });
  if (this.auditLog.length > 100) this.auditLog = this.auditLog.slice(-100);
  return this.save();
};

PodLinkSchema.methods.hasScope = function (
  scopeType: PodLinkScopeType,
  filters: { tags?: string[]; type?: string; createdAt?: Date } = {},
): boolean {
  return this.scopes.some((scope: IPodLinkScope) => {
    if (scope.type !== scopeType) return false;
    if (scope.filters?.tags?.length > 0 && filters.tags) {
      if (!filters.tags.some((t) => scope.filters.tags!.includes(t))) return false;
    }
    if (scope.filters?.types?.length > 0 && filters.type) {
      if (!scope.filters.types!.includes(filters.type)) return false;
    }
    if (scope.filters?.since && filters.createdAt) {
      if (new Date(filters.createdAt) < scope.filters.since) return false;
    }
    return true;
  });
};

export default mongoose.model<IPodLink, IPodLinkModel>('PodLink', PodLinkSchema);
