import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type ActivityType = 'message' | 'skill_created' | 'approval_needed' | 'agent_action' | 'pod_event';
export type ActivityActorType = 'human' | 'agent' | 'system';
export type ActivityApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ActivityVisibility = 'public' | 'pod' | 'private';
export type ActivitySourceType = 'message' | 'summary' | 'approval' | 'event';
export type ActivityFilter = 'all' | 'humans' | 'agents' | 'skills';

export interface IActivityReply {
  actorId?: Types.ObjectId;
  actorName?: string;
  actorType: 'human' | 'agent';
  content: string;
  createdAt: Date;
}

export interface IActivity extends Document {
  type: ActivityType;
  actor: {
    id?: Types.ObjectId;
    name?: string;
    type: ActivityActorType;
    verified?: boolean;
  };
  action: string;
  content?: string;
  podId?: Types.ObjectId;
  sourceType?: ActivitySourceType;
  sourceId?: string;
  target?: {
    title?: string;
    description?: string;
    url?: string;
  };
  approval?: {
    status: ActivityApprovalStatus;
    requestedBy?: Types.ObjectId;
    requestedScopes?: string[];
    reviewedBy?: Types.ObjectId;
    reviewedAt?: Date;
    reviewNotes?: string;
  };
  agentMetadata?: {
    agentName?: string;
    sources?: Array<{ title?: string; url?: string }>;
    confidence?: number;
    processingTime?: number;
  };
  involves?: Array<{
    id?: Types.ObjectId;
    name?: string;
    type?: 'human' | 'agent';
  }>;
  reactions: {
    likes: number;
    likedBy: Types.ObjectId[];
  };
  replies: IActivityReply[];
  replyCount: number;
  visibility: ActivityVisibility;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  addReply(userId: Types.ObjectId, userName: string, content: string, isAgent?: boolean): Promise<IActivity>;
  toggleLike(userId: Types.ObjectId): Promise<boolean>;
  approve(userId: Types.ObjectId, notes?: string): Promise<IActivity>;
  reject(userId: Types.ObjectId, notes?: string): Promise<IActivity>;
}

export interface IActivityModel extends Model<IActivity> {
  createFromMessage(message: { content: string; _id?: Types.ObjectId; id?: string }, pod: { _id: Types.ObjectId }, user: { _id: Types.ObjectId; username?: string; verified?: boolean }): Promise<IActivity>;
  createSkillActivity(summary: { content?: string; _id?: Types.ObjectId; metadata?: { sources?: string[] } }, pod: { _id: Types.ObjectId; name: string }): Promise<IActivity>;
  createApprovalRequest(options: { podId: Types.ObjectId; requestedBy: Types.ObjectId; agentName: string; scopes: string[]; content?: string }): Promise<IActivity>;
  getFeedForUser(userId: Types.ObjectId, pods: Array<{ _id: Types.ObjectId }>, options?: { limit?: number; before?: string; filter?: ActivityFilter; includeDeleted?: boolean }): Promise<IActivity[]>;
  getPendingApprovals(podIds: Types.ObjectId[]): Promise<IActivity[]>;
}

const replySchema = new Schema({
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  actorName: String,
  actorType: { type: String, enum: ['human', 'agent'], default: 'human' },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const activitySchema = new Schema<IActivity>(
  {
    type: {
      type: String,
      enum: ['message', 'skill_created', 'approval_needed', 'agent_action', 'pod_event'],
      required: true,
    },
    actor: {
      id: { type: Schema.Types.ObjectId, ref: 'User' },
      name: String,
      type: { type: String, enum: ['human', 'agent', 'system'], default: 'human' },
      verified: { type: Boolean, default: false },
    },
    action: { type: String, required: true },
    content: String,
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', index: true },
    sourceType: { type: String, enum: ['message', 'summary', 'approval', 'event'] },
    sourceId: String,
    target: {
      title: String,
      description: String,
      url: String,
    },
    approval: {
      status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
      requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      requestedScopes: [String],
      reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      reviewedAt: Date,
      reviewNotes: String,
    },
    agentMetadata: {
      agentName: String,
      sources: [{ title: String, url: String }],
      confidence: Number,
      processingTime: Number,
    },
    involves: [
      {
        id: Schema.Types.ObjectId,
        name: String,
        type: { type: String, enum: ['human', 'agent'] },
      },
    ],
    reactions: {
      likes: { type: Number, default: 0 },
      likedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    },
    replies: [replySchema],
    replyCount: { type: Number, default: 0 },
    visibility: { type: String, enum: ['public', 'pod', 'private'], default: 'pod' },
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

activitySchema.index({ podId: 1, createdAt: -1 });
activitySchema.index({ 'actor.id': 1, createdAt: -1 });
activitySchema.index({ type: 1, createdAt: -1 });
activitySchema.index({ 'approval.status': 1 }, { sparse: true });

activitySchema.statics.createFromMessage = async function (message, pod, user) {
  const isAgent = user.username?.toLowerCase().includes('bot') || user.username?.toLowerCase() === 'moltbot';
  return this.create({
    type: 'message',
    actor: { id: user._id, name: user.username, type: isAgent ? 'agent' : 'human', verified: user.verified || isAgent },
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
    actor: { id: null, name: 'commonly-bot', type: 'agent', verified: true },
    action: 'skill_created',
    content: summary.content,
    podId: pod._id,
    sourceType: 'summary',
    sourceId: summary._id?.toString(),
    target: { title: `${pod.name} Insights`, description: summary.content?.substring(0, 150) },
    agentMetadata: { agentName: 'commonly-bot', sources: summary.metadata?.sources || [] },
  });
};

activitySchema.statics.createApprovalRequest = async function (options) {
  const { podId, requestedBy, agentName, scopes, content } = options;
  return this.create({
    type: 'approval_needed',
    actor: { id: null, name: 'commonly-bot', type: 'system', verified: true },
    action: 'approval_needed',
    content: content || `Agent "${agentName}" is requesting access`,
    podId,
    approval: { status: 'pending', requestedBy, requestedScopes: scopes },
    agentMetadata: { agentName },
  });
};

activitySchema.statics.getFeedForUser = async function (userId, pods, options = {}) {
  const { limit = 20, before, filter, includeDeleted = false } = options;
  const query: Record<string, unknown> = { podId: { $in: pods.map((p: { _id: Types.ObjectId }) => p._id) } };
  if (!includeDeleted) query.deleted = { $ne: true };
  if (before) query.createdAt = { $lt: new Date(before) };
  if (filter && filter !== 'all') {
    if (filter === 'humans') query['actor.type'] = 'human';
    else if (filter === 'agents') query['actor.type'] = { $in: ['agent', 'system'] };
    else if (filter === 'skills') query.type = 'skill_created';
  }
  return this.find(query).sort({ createdAt: -1 }).limit(limit).populate('podId', 'name type').lean();
};

activitySchema.statics.getPendingApprovals = async function (podIds: Types.ObjectId[]) {
  return this.find({
    podId: { $in: podIds },
    type: 'approval_needed',
    'approval.status': 'pending',
    deleted: { $ne: true },
  }).sort({ createdAt: -1 }).lean();
};

activitySchema.methods.addReply = async function (userId: Types.ObjectId, userName: string, content: string, isAgent = false) {
  this.replies.push({ actorId: userId, actorName: userName, actorType: isAgent ? 'agent' : 'human', content });
  this.replyCount = this.replies.length;
  return this.save();
};

activitySchema.methods.toggleLike = async function (userId: Types.ObjectId): Promise<boolean> {
  const userIdStr = userId.toString();
  const likedIndex = this.reactions.likedBy.findIndex((id: Types.ObjectId) => id.toString() === userIdStr);
  if (likedIndex > -1) {
    this.reactions.likedBy.splice(likedIndex, 1);
    this.reactions.likes = Math.max(0, this.reactions.likes - 1);
  } else {
    this.reactions.likedBy.push(userId);
    this.reactions.likes += 1;
  }
  await this.save();
  return likedIndex === -1;
};

activitySchema.methods.approve = async function (userId: Types.ObjectId, notes?: string) {
  this.approval.status = 'approved';
  this.approval.reviewedBy = userId;
  this.approval.reviewedAt = new Date();
  this.approval.reviewNotes = notes;
  return this.save();
};

activitySchema.methods.reject = async function (userId: Types.ObjectId, notes?: string) {
  this.approval.status = 'rejected';
  this.approval.reviewedBy = userId;
  this.approval.reviewedAt = new Date();
  this.approval.reviewNotes = notes;
  return this.save();
};

export default mongoose.model<IActivity, IActivityModel>('Activity', activitySchema);
