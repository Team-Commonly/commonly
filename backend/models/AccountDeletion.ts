import mongoose, { Document, Schema, Types } from 'mongoose';

// Minimal durable deletion intent. Retain the opaque identity after User is
// gone so an upload already in flight cannot strand bytes on a cleanup error.
// No email, profile, password or token material belongs on this record.
export interface IAccountDeletion extends Document {
  _id: Types.ObjectId;
  createdAt: Date;
  lastSweptAt?: Date;
}
const schema = new Schema<IAccountDeletion>({
  _id: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: Date.now },
  lastSweptAt: { type: Date },
});
schema.index({ lastSweptAt: 1, _id: 1 });
export default mongoose.model<IAccountDeletion>('AccountDeletion', schema);
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
