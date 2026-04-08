import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IInvitationCode extends Document {
  code: string;
  createdBy: Types.ObjectId;
  note: string;
  maxUses: number;
  useCount: number;
  isActive: boolean;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const invitationCodeSchema = new Schema<IInvitationCode>(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    note: { type: String, trim: true, default: '' },
    maxUses: { type: Number, default: 1, min: 1 },
    useCount: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

invitationCodeSchema.index({ isActive: 1, expiresAt: 1 });

export default mongoose.model<IInvitationCode>('InvitationCode', invitationCodeSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
