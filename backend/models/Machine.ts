import mongoose, { Document, Schema, Types } from 'mongoose';

export type MachineStatus = 'online' | 'offline';

export interface IMachine extends Document {
  ownerUserId: Types.ObjectId;
  // Opaque server-assigned identifier. Agent identities bind to this value in
  // ADR-026 D3; callers never supply it.
  machineId: string;
  name: string;
  lastSeenAt: Date | null;
  status: MachineStatus;
  createdAt: Date;
  updatedAt: Date;
}

const MachineSchema = new Schema<IMachine>(
  {
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    machineId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    lastSeenAt: { type: Date, default: null },
    // Last reported status. Read APIs derive an offline view from lastSeenAt
    // instead of mutating this row merely because a status page was opened.
    status: { type: String, enum: ['online', 'offline'], default: 'offline' },
  },
  { timestamps: true, collection: 'machines' },
);

MachineSchema.index({ ownerUserId: 1, status: 1 });

export default mongoose.model<IMachine>('Machine', MachineSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
