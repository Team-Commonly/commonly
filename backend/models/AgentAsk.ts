import mongoose, { Document, Model, Schema, Types } from 'mongoose';

// ADR-003 Phase 4: cross-agent ask/respond. An "ask" is a structured DM
// from agent A to agent B in the same pod, with a requestId so the
// response can be routed back. The kernel records the open ask, fans the
// `agent.ask` event to the target via AgentEventService, and waits for the
// target to call `respondToAsk(requestId, content)` — which fans the
// `agent.ask.response` event back to the original sender.
//
// Stored as its own collection (not on AgentEvent) so:
//   - the open/responded/expired lifecycle is queryable independently
//   - the response can be looked up by requestId without scanning events
//   - TTL on expiresAt cleans up stale asks without touching events

export type AgentAskStatus = 'open' | 'responded' | 'expired';

export interface IAgentAsk extends Document {
  requestId: string;
  podId: Types.ObjectId;
  fromAgent: string;
  fromInstanceId: string;
  targetAgent: string;
  targetInstanceId: string;
  question: string;
  status: AgentAskStatus;
  response?: string;
  createdAt: Date;
  respondedAt?: Date;
  expiresAt: Date;
  updatedAt: Date;
}

const AgentAskSchema = new Schema<IAgentAsk>(
  {
    // requestId is caller-controlled. Bound the length so a misbehaving
    // (or compromised) agent token can't push 10MB strings into a unique
    // index. Validation also lives in the service before insert; the schema
    // bound is the last line of defense for any code path that bypasses it.
    requestId: {
      type: String, required: true, unique: true, index: true, maxlength: 128,
    },
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    // All agent + instance identifiers are normalized at write time so the
    // case-sensitive comparison in `respondToAsk` (responderAgent ===
    // ask.targetAgent && responderInstance === ask.targetInstanceId) never
    // wedges on case drift. Service-layer normalization is defense in depth;
    // the schema is the authoritative normalization point.
    fromAgent: { type: String, required: true, lowercase: true, trim: true },
    fromInstanceId: {
      type: String, default: 'default', lowercase: true, trim: true,
    },
    targetAgent: { type: String, required: true, lowercase: true, trim: true },
    targetInstanceId: {
      type: String, default: 'default', lowercase: true, trim: true,
    },
    question: { type: String, required: true },
    status: {
      type: String,
      enum: ['open', 'responded', 'expired'],
      default: 'open',
    },
    response: { type: String },
    respondedAt: { type: Date },
    // 24h default TTL — Mongo's TTL monitor sweeps documents whose
    // expiresAt has passed. Covers the "agent A asked, then disappeared"
    // case so the collection doesn't grow unbounded.
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
      index: { expireAfterSeconds: 0 },
    },
  },
  { timestamps: true },
);

// Pod-scoped queries (e.g. "show me open asks I've sent in this pod") and
// rate-limit lookups (count asks fromAgent emitted in the last hour) both
// hit this index. Keeping it composite avoids a separate single-field index
// on podId (Mongo can prefix-match).
AgentAskSchema.index({ podId: 1, status: 1 });
AgentAskSchema.index({ fromAgent: 1, fromInstanceId: 1, createdAt: -1 });

const AgentAsk: Model<IAgentAsk> = (mongoose.models.AgentAsk as Model<IAgentAsk>)
  || mongoose.model<IAgentAsk>('AgentAsk', AgentAskSchema);

export default AgentAsk;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
