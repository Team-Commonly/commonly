import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * ApprovalAction — ADR-020 D2/D3, implementing ADR-017's escalation-card
 * lifecycle for agent-proposed actions.
 *
 * One row per proposed action. The chat card (Message.payload with
 * kind 'approval-card') is the RENDER of this row — this row is the truth.
 * Lifecycle (ADR-017): flagged → resolved | expired | moot. Invariants the
 * route layer enforces and tests pin:
 *   - only a HUMAN writes `resolved` (no agent token may decide)
 *   - only the owning user may decide (ownerUserId)
 *   - transitions are one-way and idempotent: a card resolves at most once,
 *     and execution happens at most once (executedAt set exactly when the
 *     approved action ran)
 *   - expiresAt is advisory AGE, never refusal (ADR-017:201): a decision
 *     past it is honored and stamped `decidedAfterExpiry`. Nothing writes
 *     status 'expired' in v1 — the state exists for future sweeps only.
 *
 * The resolved row IS the AuthorizedAction record from ADR-020 D2: it links
 * the approving user, the executing agent identity, the action + params, and
 * the execution result. Never deleted (audit trail); no TTL index.
 */

export type ApprovalStatus = 'flagged' | 'resolved' | 'expired' | 'moot';
export type ApprovalDecision = 'approved' | 'declined';

// Registry of executable action types. Adding an action means adding its
// executor in services/approvalExecutors.ts — the enum here only widens in
// the same PR as an executor, so a card can never exist for an action the
// kernel cannot run.
export type ApprovalActionType = 'create_pod' | 'connect_local_agent';

export interface IApprovalAction extends Document {
  podId: Types.ObjectId;
  // Message id of the rendered card. String because messages live in PG
  // (serial int) with a Mongo fallback (ObjectId hex).
  messageId?: string;
  ownerUserId: Types.ObjectId;
  agentName: string;
  instanceId: string;
  actionType: ApprovalActionType;
  params: Record<string, unknown>;
  summary: string;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  resolvedBy?: Types.ObjectId;
  resolvedAt?: Date;
  // ADR-017:201 — expiry is advisory age, not refusal. A decision landed
  // past expiresAt is honored AND stamped, so the audit record carries the
  // staleness fact.
  decidedAfterExpiry?: boolean;
  executedAt?: Date;
  executionResult?: unknown;
  executionError?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const ApprovalActionSchema = new Schema<IApprovalAction>(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    messageId: { type: String },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    agentName: { type: String, required: true, lowercase: true, trim: true },
    instanceId: { type: String, default: 'default' },
    actionType: { type: String, enum: ['create_pod', 'connect_local_agent'], required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    summary: { type: String, required: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['flagged', 'resolved', 'expired', 'moot'],
      default: 'flagged',
    },
    decision: { type: String, enum: ['approved', 'declined'] },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
    decidedAfterExpiry: { type: Boolean },
    executedAt: { type: Date },
    executionResult: { type: Schema.Types.Mixed },
    executionError: { type: String },
    // Plain Date — deliberately NOT a Mongo TTL index: expiry is a lifecycle
    // STATE (the card renders "expired"), not a deletion.
    expiresAt: { type: Date, default: () => new Date(Date.now() + DEFAULT_TTL_MS) },
  },
  { timestamps: true },
);

ApprovalActionSchema.index({ podId: 1, status: 1 });
ApprovalActionSchema.index({ ownerUserId: 1, status: 1 });

export const ApprovalAction: Model<IApprovalAction> =
  (mongoose.models.ApprovalAction as Model<IApprovalAction>)
  || mongoose.model<IApprovalAction>('ApprovalAction', ApprovalActionSchema);

export default ApprovalAction;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
