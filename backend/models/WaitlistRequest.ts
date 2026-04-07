import mongoose, { Document, Schema, Types } from 'mongoose';

export type WaitlistStatus = 'pending' | 'invited' | 'closed';

export interface IWaitlistRequest extends Document {
  email: string;
  name: string;
  organization: string;
  useCase: string;
  note: string;
  status: WaitlistStatus;
  invitationCode?: Types.ObjectId | null;
  invitedAt?: Date | null;
  invitationSentAt?: Date | null;
  invitedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const waitlistRequestSchema = new Schema<IWaitlistRequest>(
  {
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    name: { type: String, trim: true, default: '' },
    organization: { type: String, trim: true, default: '' },
    useCase: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: ['pending', 'invited', 'closed'],
      default: 'pending',
      index: true,
    },
    invitationCode: { type: Schema.Types.ObjectId, ref: 'InvitationCode', default: null },
    invitedAt: { type: Date, default: null },
    invitationSentAt: { type: Date, default: null },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

waitlistRequestSchema.index({ createdAt: -1 });

export default mongoose.model<IWaitlistRequest>('WaitlistRequest', waitlistRequestSchema);
