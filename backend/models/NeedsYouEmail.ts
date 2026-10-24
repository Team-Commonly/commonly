import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface INeedsYouEmail extends Document {
  attentionItemId: Types.ObjectId;
  recipientUserId: Types.ObjectId;
  clickToken: string;
  status: 'claimed' | 'sent' | 'overflow' | 'failed';
  sentAt?: Date;
  clickedAt?: Date;
  includedInDigestAt?: Date;
  createdAt: Date;
}

const schema = new Schema<INeedsYouEmail>({
  attentionItemId: { type: Schema.Types.ObjectId, ref: 'AttentionItem', required: true, unique: true },
  recipientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clickToken: { type: String, required: true, unique: true, select: false },
  status: { type: String, enum: ['claimed', 'sent', 'overflow', 'failed'], required: true },
  sentAt: Date,
  clickedAt: Date,
  includedInDigestAt: Date,
}, { timestamps: true });

const NeedsYouEmail: Model<INeedsYouEmail> = mongoose.models.NeedsYouEmail
  || mongoose.model<INeedsYouEmail>('NeedsYouEmail', schema);

export default NeedsYouEmail;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = NeedsYouEmail;
