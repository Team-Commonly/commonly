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

import type { HarnessInventory } from '../services/runtimeInventory';

// TASK-784 (D164): what the daemon's computer runs, as metadata only. Each
// field is checked against a fixed shape on the way in (machineService
// normalizeHostReport), so no hostname, path or user name can be stored here.
export interface IMachineHost {
  platform: string | null;
  osMajor: number | null;
  arch: string | null;
  cliVersion: string | null;
}

export interface IMachine extends Document {
  ownerUserId: Types.ObjectId;
  // Opaque server-assigned identifier. Agent identities bind to this value in
  // ADR-026 D3; callers never supply it.
  machineId: string;
  // Hash of the device-login bearer that registered this machine. Older rows
  // lack this field; they are handled conservatively on device revocation.
  registeredByDeviceTokenHash?: string | null;
  name: string;
  lastSeenAt: Date | null;
  status: MachineStatus;
  agentStates: IMachineAgentState[];
  runtimeInventory: HarnessInventory[];
  inventoryAt: Date | null;
  // D245: the daemon reported that its user chose to run agents without a
  // sandbox (native Windows, `commonly daemon install --unsandboxed`). Grants
  // are refused for every seat bound to this machine while it is true.
  hostUnconfined: boolean;
  // TASK-784: null until a CLI that reports it registers or checks in.
  host: IMachineHost | null;
  hostReportedAt: Date | null;
  // TASK-784: when an agent bound to this machine first acked a person-waiting
  // event (an @mention or a DM) with a posted reply. Set once, never moved.
  firstAnswerAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MachineSchema = new Schema<IMachine>(
  {
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    machineId: { type: String, required: true, unique: true },
    registeredByDeviceTokenHash: { type: String },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    lastSeenAt: { type: Date, default: null },
    // Last reported status. Read APIs derive an offline view from lastSeenAt
    // instead of mutating this row merely because a status page was opened.
    status: { type: String, enum: ['online', 'offline'], default: 'offline' },
    // D5: replaced wholesale by each heartbeat that carries an agents array —
    // the daemon's report is the truth, so no per-entry merging.
    runtimeInventory: { type: Schema.Types.Mixed, default: [] },
    inventoryAt: { type: Date, default: null },
    hostUnconfined: { type: Boolean, default: false },
    host: {
      type: new Schema({
        platform: { type: String, default: null },
        osMajor: { type: Number, default: null },
        arch: { type: String, default: null },
        cliVersion: { type: String, default: null },
      }, { _id: false }),
      default: null,
    },
    hostReportedAt: { type: Date, default: null },
    firstAnswerAt: { type: Date, default: null },
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
