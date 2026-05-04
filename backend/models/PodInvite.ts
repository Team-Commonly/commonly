import mongoose, { Schema, Document, Types, Model } from 'mongoose';

export interface IPodInvite extends Document {
  token: string;
  podId: Types.ObjectId;
  createdBy: Types.ObjectId;
  expiresAt?: Date | null;
  maxUses?: number | null;
  useCount: number;
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  isUsable(): boolean;
}

const PodInviteSchema = new Schema<IPodInvite>(
  {
    token: { type: String, required: true, unique: true, index: true },
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, default: null },
    maxUses: { type: Number, default: null },
    useCount: { type: Number, default: 0 },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

PodInviteSchema.methods.isUsable = function isUsable(this: IPodInvite): boolean {
  if (this.revokedAt) return false;
  if (this.expiresAt && this.expiresAt.getTime() < Date.now()) return false;
  if (this.maxUses != null && this.useCount >= this.maxUses) return false;
  return true;
};

export const PodInvite: Model<IPodInvite> = mongoose.models.PodInvite
  || mongoose.model<IPodInvite>('PodInvite', PodInviteSchema);

export default PodInvite;
