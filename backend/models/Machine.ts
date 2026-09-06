import mongoose, { Document, Schema, Types } from 'mongoose';

export type MachineStatus = 'online' | 'offline';

// ADR-026 D5: per-agent supervisor state, reported by the daemon on each
// heartbeat. 'crashed' means the supervisor observed an abnormal exit and is
// backing off; restarts counts supervisor-initiated respawns since adoption.
export type AgentRunState = 'running' | 'stopped' | 'crashed';

export interface IMachineAgentState {
  agentName: string;
  instanceId: string;
  state: AgentRunState;
  restarts: number;
}

export interface IMachine extends Document {
  ownerUserId: Types.ObjectId;
  // Opaque server-assigned identifier. Agent identities bind to this value in
  // ADR-026 D3; callers never supply it.
  machineId: string;
  name: string;
  lastSeenAt: Date | null;
  status: MachineStatus;
  agentStates: IMachineAgentState[];
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
    // D5: replaced wholesale by each heartbeat that carries an agents array —
    // the daemon's report is the truth, so no per-entry merging.
    agentStates: {
      type: [{
        _id: false,
        agentName: { type: String, required: true },
        instanceId: { type: String, required: true, default: 'default' },
        state: { type: String, enum: ['running', 'stopped', 'crashed'], required: true },
        restarts: { type: Number, default: 0, min: 0 },
      }],
      default: [],
    },
  },
  { timestamps: true, collection: 'machines' },
);

MachineSchema.index({ ownerUserId: 1, status: 1 });

export default mongoose.model<IMachine>('Machine', MachineSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
