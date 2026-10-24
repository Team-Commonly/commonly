import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/** Unread ambient events folded out of the full AgentEvent retention window. */
export interface IAgentDigestState extends Document {
  agentName: string;
  instanceId: string;
  podId: Types.ObjectId;
  unreadCount: number;
  revision: number;
  lastEventIds: string[];
  conversations: Array<{ label: string; count: number }>;
  otherCount: number;
  unreadSince?: Date | null;
  foldedThroughId?: Types.ObjectId | null;
  updatedAt: Date;
}

const schema = new Schema<IAgentDigestState>({
  agentName: { type: String, required: true, lowercase: true },
  instanceId: { type: String, required: true, default: 'default' },
  podId: { type: Schema.Types.ObjectId, required: true, ref: 'Pod' },
  unreadCount: { type: Number, required: true, default: 0 },
  revision: { type: Number, required: true, default: 0 },
  lastEventIds: { type: [String], default: [] },
  conversations: { type: [{ label: String, count: Number, _id: false }], default: [] },
  otherCount: { type: Number, default: 0 },
  unreadSince: { type: Date, default: null },
  foldedThroughId: { type: Schema.Types.ObjectId, default: null },
}, { timestamps: true });

schema.index({ agentName: 1, instanceId: 1, podId: 1 }, { unique: true });
schema.index({ unreadCount: 1, unreadSince: 1 });

const AgentDigestState: Model<IAgentDigestState> = mongoose.model<IAgentDigestState>('AgentDigestState', schema);
export default AgentDigestState;
module.exports = exports["default"]; Object.assign(module.exports, exports);
