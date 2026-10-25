import mongoose, { Schema } from 'mongoose';

// Runner observations are separate from desired installation configuration.
// No raw argv, environment, error text, prompt or provider response belongs here.
const receipt = new Schema({
  harness: { type: String, required: true },
  version: { type: String, default: null },
  model: { type: String, default: null },
  effort: { type: String, default: null },
  at: { type: Date, required: true },
}, { _id: false });
const schema = new Schema({
  agentUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  machineId: { type: String, required: true },
  connectedAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  turnRunning: { type: Boolean, default: false },
  lastTurnAt: { type: Date, default: null },
  lastSpawnOutcome: { type: String, enum: ['completed', 'failed', null], default: null },
  lastSpawn: { type: receipt, default: null },
}, { timestamps: true });
export default mongoose.model('AgentRuntimeObservation', schema);
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
