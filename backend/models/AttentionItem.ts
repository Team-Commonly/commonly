import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type AttentionKind = 'mention' | 'approval' | 'decision';
export type AttentionSourceType = 'message' | 'approval' | 'decision_request' | 'task';

export interface IAttentionItem extends Document {
  recipientUserId: Types.ObjectId;
  podId: Types.ObjectId;
  kind: AttentionKind;
  source: { type: AttentionSourceType; id: string };
  title: string;
  detail?: string;
  podName?: string;
  messageId?: string;
  threadRootId?: string;
  options?: Array<{ label: string; description?: string; recommended?: boolean }>;
  status: 'open' | 'resolved';
  resolvedAt?: Date;
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
  kind: { type: String, enum: ['mention', 'approval', 'decision'], required: true },
  source: {
    type: { type: String, enum: ['message', 'approval', 'decision_request', 'task'], required: true },
    id: { type: String, required: true },
  },
  title: { type: String, required: true },
  detail: { type: String },
  podName: { type: String },
  messageId: { type: String },
  threadRootId: { type: String },
  options: [optionSchema],
  status: { type: String, enum: ['open', 'resolved'], default: 'open', required: true },
  resolvedAt: { type: Date },
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
