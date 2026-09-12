import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IHookLedgerEvent extends Document {
  podId: string;
  agentId: string;
  agentName: string;
  eventId: string;
  event: string;
  tool?: string;
  argsDigest?: string;
  paths: string[];
  permissionDecision: 'allow' | 'deny';
  reason?: string;
  holder?: string;
  createdAt: Date;
}

const HookLedgerEventSchema = new Schema<IHookLedgerEvent>(
  {
    podId: { type: String, required: true },
    // Runtime agent user id is the seat identity.  agentName is retained only
    // as a human-readable label and for installation lookup compatibility.
    agentId: { type: String, required: true },
    agentName: { type: String, required: true, lowercase: true },
    eventId: { type: String, required: true },
    event: { type: String, required: true },
    tool: { type: String },
    argsDigest: { type: String, match: /^[a-f0-9]{64}$/i },
    // Resolved paths are safe metadata; raw tool arguments are intentionally
    // not represented in this ledger schema.
    paths: { type: [String], default: [] },
    permissionDecision: { type: String, enum: ['allow', 'deny'], required: true },
    reason: { type: String },
    holder: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

HookLedgerEventSchema.index({ podId: 1, agentId: 1, eventId: 1 }, { unique: true });

const HookLedgerEvent: Model<IHookLedgerEvent> = (
  mongoose.models.HookLedgerEvent as Model<IHookLedgerEvent>
) || mongoose.model<IHookLedgerEvent>('HookLedgerEvent', HookLedgerEventSchema);

export default HookLedgerEvent;
module.exports = HookLedgerEvent;
