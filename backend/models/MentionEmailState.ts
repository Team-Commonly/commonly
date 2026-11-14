import mongoose, { Document, Model, Schema, Types } from 'mongoose';

// One row per recipient and pod: when the last mention email went (F512).
// The 6h window is claimed on this row before the provider call, so two passes
// cannot both send, and a failed send gives the window back.
export interface IMentionEmailState extends Document {
  recipientUserId: Types.ObjectId;
  podId: Types.ObjectId;
  lastEmailAt?: Date;
  attentionItemId?: Types.ObjectId;
}

const schema = new Schema<IMentionEmailState>({
  recipientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
  lastEmailAt: { type: Date },
  attentionItemId: { type: Schema.Types.ObjectId, ref: 'AttentionItem' },
});

schema.index({ recipientUserId: 1, podId: 1 }, { unique: true });

const MentionEmailState: Model<IMentionEmailState> = mongoose.models.MentionEmailState
  || mongoose.model<IMentionEmailState>('MentionEmailState', schema);

export default MentionEmailState;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = MentionEmailState;
