import mongoose, { Document, Model, Schema, Types } from 'mongoose';
import type { CallerConfinement } from './ToolCall';

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
 *   - expiresAt is advisory AGE for legacy actions; tool_call actions close
 *     as `expired` and scrub their envelope when the deadline passes.
 *
 * The resolved row IS the AuthorizedAction record from ADR-020 D2: it links
 * the approving user, the executing agent identity, and the action + params.
 * Legacy actions keep their result; tool calls keep ending/code/trail id, never
 * vendor result prose. Never deleted (audit trail); no TTL index.
 */

export type ApprovalStatus = 'flagged' | 'resolved' | 'expired' | 'moot';
export type ApprovalDecision = 'approved' | 'declined';
export type ApprovalToolCallEnding = 'ran' | 'failed' | 'refused' | 'declined' | 'expired';
/** record-v1 `decidedByRole` values a parked call can carry today. The spec
 * reserves `decision-owner`; delegated approval is deferred (TASK-512). */
export type ToolCallDecidedByRole = 'credential-owner' | 'policy';

// Registry of executable action types. Adding an action means adding its
// executor in services/approvalExecutors.ts — the enum here only widens in
// the same PR as an executor, so a card can never exist for an action the
// kernel cannot run.
export type ApprovalActionType = 'create_pod' | 'connect_local_agent' | 'tool_call';

/** Server-only envelope for a parked broker call. canonicalArgs is present
 * only while the action is flagged and is scrubbed on every terminal write. */
export interface ApprovalToolCall {
  grantId: string;
  callId: string;
  tool: string;
  canonicalArgs?: Record<string, unknown>;
  argsDigest: string;
  /** Complete hosted pin at park time; absent for GitHub App calls. */
  definitionDigest?: string;
  /**
   * Whose credential the parked call would spend (scope §8), copied from the
   * resolved Connection so the record written at DECISION time still names the
   * owner after the Connection row is deleted.
   */
  credentialOwnerId?: string;
  /**
   * TASK-783: how the broker judged the caller when it parked (hosted, a
   * confined seat, a seat the grant names). Server-written; the approved call
   * is judged again against it before anything reaches the provider.
   */
  callerConfinement?: CallerConfinement;
}

export interface IApprovalAction extends Document {
  podId: Types.ObjectId;
  // Message id of the rendered card. String because messages live in PG
  // (serial int) with a Mongo fallback (ObjectId hex).
  messageId?: string;
  /** Originating native run; persists when the card changes state. */
  runId?: Types.ObjectId;
  runPodId?: Types.ObjectId;
  ownerUserId: Types.ObjectId;
  agentName: string;
  /** Server-only executor identity for tool_call; never in the shared card. */
  agentUserId?: string;
  instanceId: string;
  actionType: ApprovalActionType;
  params: Record<string, unknown>;
  toolCall?: ApprovalToolCall;
  /**
   * tool_call only (F184): which of the seat's open-card slots in this pod the
   * row holds, 0..MAX_OPEN_TOOL_CALL_APPROVALS-1. Two partial unique indexes
   * read it: one makes the cap atomic, the other makes reuse of an identical
   * open call atomic. A row stops holding its slot when it leaves `flagged`.
   * Absent on rows written before F184, which neither index sees.
   */
  toolCallSlot?: number;
  /**
   * tool_call only (F184): later runs that called the identical tool while
   * this approval was open and were parked on it instead of getting a card of
   * their own. The decision event names them beside `runId`.
   */
  waitingRuns?: Array<{ runId: Types.ObjectId; runPodId?: Types.ObjectId }>;
  summary: string;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  resolvedBy?: Types.ObjectId;
  resolvedAt?: Date;
  /**
   * tool_call only: who decided the parked call, stored when the decision
   * commits so the grant record reads it instead of inferring it (ADR-033 B3/B4).
   * A user id with `credential-owner`, or `policy` for both when it expired.
   */
  decidedBy?: string;
  decidedByRole?: ToolCallDecidedByRole;
  // ADR-017:201 remains the legacy default. tool_call is terminal on expiry
  // because it authorizes disclosure to an external provider.
  decidedAfterExpiry?: boolean;
  executedAt?: Date;
  executionResult?: unknown;
  executionError?: string;
  /** Broker-only terminal facts. Vendor result and error prose stay in the trail/provider, not this card. */
  toolCallEnding?: ApprovalToolCallEnding;
  toolCallCode?: string;
  toolCallTrailId?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const ApprovalActionSchema = new Schema<IApprovalAction>(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    messageId: { type: String },
    runId: { type: Schema.Types.ObjectId, ref: 'AgentRun' },
    runPodId: { type: Schema.Types.ObjectId, ref: 'Pod' },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    agentName: { type: String, required: true, lowercase: true, trim: true },
    agentUserId: { type: String },
    instanceId: { type: String, default: 'default' },
    actionType: { type: String, enum: ['create_pod', 'connect_local_agent', 'tool_call'], required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    // Mixed keeps this optional for legacy action rows. The service validates
    // the required envelope fields before a tool_call row is created.
    toolCall: { type: Schema.Types.Mixed },
    toolCallSlot: { type: Number },
    waitingRuns: {
      type: [{
        _id: false,
        runId: { type: Schema.Types.ObjectId, ref: 'AgentRun', required: true },
        runPodId: { type: Schema.Types.ObjectId, ref: 'Pod' },
      }],
      default: undefined,
    },
    summary: { type: String, required: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['flagged', 'resolved', 'expired', 'moot'],
      default: 'flagged',
    },
    decision: { type: String, enum: ['approved', 'declined'] },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
    decidedBy: { type: String },
    decidedByRole: { type: String, enum: ['credential-owner', 'policy'] },
    decidedAfterExpiry: { type: Boolean },
    executedAt: { type: Date },
    executionResult: { type: Schema.Types.Mixed },
    executionError: { type: String },
    toolCallEnding: { type: String, enum: ['ran', 'failed', 'refused', 'declined', 'expired'] },
    toolCallCode: { type: String },
    toolCallTrailId: { type: String },
    // Plain Date — deliberately NOT a Mongo TTL index: expiry is a lifecycle
    // STATE (the card renders "expired"), not a deletion.
    expiresAt: { type: Date, default: () => new Date(Date.now() + DEFAULT_TTL_MS) },
  },
  { timestamps: true },
);

ApprovalActionSchema.index({ podId: 1, status: 1 });
ApprovalActionSchema.index({ ownerUserId: 1, status: 1 });

// F184: the broker's open-card guards, enforced by the store rather than by a
// read before the write. Both are PARTIAL on `toolCallSlot` existing, so they
// see only rows written by F184 code: rows already in the collection (which
// can hold duplicates, since nothing deduped tool calls before F180) are not
// indexed, and the boot-time autoIndex build cannot fail on them. Those rows
// leave `flagged` within their 24-hour deadline. The filters use equality and
// `$exists` only, the operators FerretDB accepts in a partial index (ADR-034).
const OPEN_TOOL_CALL_SLOT = {
  actionType: 'tool_call',
  status: 'flagged',
  toolCallSlot: { $exists: true },
};
// One open approval per identical call: the key is the reuse lookup's key.
// A missing definitionDigest indexes as null, so GitHub App calls key alike.
ApprovalActionSchema.index(
  {
    podId: 1, agentUserId: 1, ownerUserId: 1, 'toolCall.grantId': 1, 'toolCall.tool': 1,
    'toolCall.argsDigest': 1, 'toolCall.definitionDigest': 1,
  },
  { unique: true, name: 'tool_call_open_identity', partialFilterExpression: OPEN_TOOL_CALL_SLOT },
);
// At most one open row per (pod, seat, slot), and slots run 0..cap-1, so the
// cap holds under any interleaving. Closing a row frees its slot by dropping
// it out of the partial index: there is no counter to release or drift.
ApprovalActionSchema.index(
  { podId: 1, agentUserId: 1, toolCallSlot: 1 },
  { unique: true, name: 'tool_call_open_slot', partialFilterExpression: OPEN_TOOL_CALL_SLOT },
);

export const ApprovalAction: Model<IApprovalAction> =
  (mongoose.models.ApprovalAction as Model<IApprovalAction>)
  || mongoose.model<IApprovalAction>('ApprovalAction', ApprovalActionSchema);

export default ApprovalAction;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
