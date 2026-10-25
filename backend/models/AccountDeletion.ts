import mongoose, { Document, Schema, Types } from 'mongoose';

// Minimal durable deletion intent. Retain the opaque identity after User is
// gone so an upload already in flight cannot strand bytes on a cleanup error.
// No email, profile, password or token material belongs on this record.
export interface IAccountDeletion extends Document {
  _id: Types.ObjectId;
  createdAt: Date;
}
const schema = new Schema<IAccountDeletion>({
  _id: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: Date.now },
});
export default mongoose.model<IAccountDeletion>('AccountDeletion', schema);
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
