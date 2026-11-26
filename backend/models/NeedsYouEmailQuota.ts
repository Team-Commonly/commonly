import mongoose, { Document, Model, Schema, Types } from 'mongoose';
import { dualStorePlugin } from '../repositories/dualStore';

interface INeedsYouEmailQuota extends Document {
  recipientUserId: Types.ObjectId;
  day: string;
  count: number;
}

const schema = new Schema<INeedsYouEmailQuota>({
  recipientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  day: { type: String, required: true },
  count: { type: Number, required: true, default: 0 },
});

schema.index({ recipientUserId: 1, day: 1 }, { unique: true });
// ADR-034 step 2: the repair markers (pgVersion, pgPending, pgDeleted) and their sparse index.
dualStorePlugin(schema);

const NeedsYouEmailQuota: Model<INeedsYouEmailQuota> = mongoose.models.NeedsYouEmailQuota
  || mongoose.model<INeedsYouEmailQuota>('NeedsYouEmailQuota', schema);

export default NeedsYouEmailQuota;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = NeedsYouEmailQuota;
