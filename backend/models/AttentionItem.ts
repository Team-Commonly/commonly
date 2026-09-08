import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type AttentionKind = 'mention' | 'approval' | 'decision' | 'handoff';
export type AttentionSourceType = 'message' | 'approval' | 'decision_request' | 'task';

export interface IAttentionItem extends Document {
  recipientUserId: Types.ObjectId;
  podId: Types.ObjectId;
  kind: AttentionKind;
  source: { type: AttentionSourceType; id: string };
  title: string;
  detail?: string;
  podName?: string;
  actorName?: string;
  /**
   * The principal whose ask this item carries: the mention's author, the
   * approval's requester, the decision's agent. Keyed by id because
   * `actorName` holds three different shapes across the three writers and
   * is absent on decisions entirely.
   */
  actorUserId?: Types.ObjectId;
  messageId?: string;
  threadRootId?: string;
  options?: Array<{ label: string; description?: string; recommended?: boolean }>;
  // The authoritative time of a mention source. It lets a later reply close
  // only attention that predates that reply, instead of treating any message
  // in the pod as an acknowledgement.
  sourceCreatedAt?: Date;
  status: 'open' | 'resolved';
  resolvedAt?: Date;
  // Mention rows may resolve when their recipient replies; mention and handoff
  // rows also support an explicit recipient acknowledgement. Decision and
  // approval actions have source-specific writers and never become dismissible
  // through this field.
  resolvedBy?: 'replied' | 'acknowledged';
  createdAt: Date;
  updatedAt: Date;
}

const optionSchema = new Schema({
  label: { type: String, required: true },
  description: { type: String },
  recommended: { type: Boolean },
}, { _id: false });

const attentionItemSchema = new Schema<IAttentionItem>({
  recipientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
  kind: { type: String, enum: ['mention', 'approval', 'decision', 'handoff'], required: true },
  source: {
    type: { type: String, enum: ['message', 'approval', 'decision_request', 'task'], required: true },
    id: { type: String, required: true },
  },
  title: { type: String, required: true },
  detail: { type: String },
  podName: { type: String },
  actorName: { type: String },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  messageId: { type: String },
  threadRootId: { type: String },
  options: [optionSchema],
  sourceCreatedAt: { type: Date },
  status: { type: String, enum: ['open', 'resolved'], default: 'open', required: true },
  resolvedAt: { type: Date },
  resolvedBy: { type: String, enum: ['replied', 'acknowledged'] },
}, { timestamps: true });

// A source can notify each recipient once. Retried source writes must not
// duplicate cards or resurrect a recipient's acknowledgement.
attentionItemSchema.index({ recipientUserId: 1, 'source.type': 1, 'source.id': 1 }, { unique: true });
attentionItemSchema.index({ recipientUserId: 1, status: 1, createdAt: -1 });
attentionItemSchema.index({ podId: 1, status: 1, createdAt: -1 });

const AttentionItem: Model<IAttentionItem> = mongoose.models.AttentionItem
  || mongoose.model<IAttentionItem>('AttentionItem', attentionItemSchema);

export default AttentionItem;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = AttentionItem;
