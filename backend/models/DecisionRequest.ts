import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * An agent-authored fork that needs a human ruling.
 *
 * A DecisionRequest is deliberately distinct from ApprovalAction: it carries
 * a question and declared alternatives, never an executable action or a
 * credential-bearing payload. Privileged, real-world actions keep using the
 * owner-scoped approval path.
 */
export interface DecisionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

// A DecisionRequest is intentionally limited to advisory forks. Any class
// that could authorize an outward-facing act, credential use, or other
// side-effect belongs to ApprovalAction instead.
export const DECISION_CLASSES = ['strategy', 'implementation', 'prioritization'] as const;
export type DecisionClass = typeof DECISION_CLASSES[number];

export interface DecisionRuling {
  value: string;
  byUserId: Types.ObjectId;
  byUsername: string;
  at: Date;
  messageId: string;
}

export interface IDecisionRequest extends Document {
  podId: Types.ObjectId;
  agentUserId: Types.ObjectId;
  agentName: string;
  instanceId: string;
  decisionClass: DecisionClass;
  title: string;
  question: string;
  context?: string;
  options: DecisionOption[];
  status: 'pending' | 'ruled';
  messageId?: string;
  threadRootId?: string;
  ruling?: DecisionRuling;
  rulingLock?: { token: string; expiresAt: Date };
  createdAt: Date;
  updatedAt: Date;
}

const DecisionOptionSchema = new Schema<DecisionOption>(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 280 },
    recommended: { type: Boolean, default: false },
  },
  { _id: false },
);

const DecisionRequestSchema = new Schema<IDecisionRequest>(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    // Provenance is derived from the authenticated runtime identity, never
    // accepted from the MCP/CAP request body.
    agentUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    agentName: { type: String, required: true, trim: true, lowercase: true },
    instanceId: { type: String, required: true, trim: true, lowercase: true, default: 'default' },
    decisionClass: { type: String, required: true, enum: DECISION_CLASSES },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    question: { type: String, required: true, trim: true, maxlength: 1000 },
    context: { type: String, trim: true, maxlength: 2000 },
    options: {
      type: [DecisionOptionSchema], required: true, validate: {
        validator: (options: DecisionOption[]) => Array.isArray(options) && options.length >= 2 && options.length <= 4,
        message: 'DecisionRequest options must contain 2–4 choices',
      },
    },
    status: { type: String, enum: ['pending', 'ruled'], default: 'pending', index: true },
    // Assigned only after the asker's source message persists. Pending rows
    // without it are intentionally invisible to the Activity projection.
    messageId: { type: String, trim: true },
    threadRootId: { type: String, trim: true },
    ruling: {
      value: { type: String, trim: true, maxlength: 2000 },
      byUserId: { type: Schema.Types.ObjectId, ref: 'User' },
      byUsername: { type: String, trim: true },
      at: { type: Date },
      messageId: { type: String, trim: true },
    },
    // A short write lease prevents two browser tabs from posting conflicting
    // replies before the compare-and-set can record the winning ruling.
    rulingLock: {
      token: { type: String },
      expiresAt: { type: Date },
    },
  },
  { timestamps: true },
);

// The Activity queue is a cross-pod read over a human's memberships. This
// index supplies its pod/status filter; individual pod thread lookups use the
// messageId stored on the row.
DecisionRequestSchema.index({ podId: 1, status: 1, createdAt: -1 });

const DecisionRequest: Model<IDecisionRequest> = (mongoose.models.DecisionRequest as Model<IDecisionRequest>)
  || mongoose.model<IDecisionRequest>('DecisionRequest', DecisionRequestSchema);

export default DecisionRequest;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = DecisionRequest;
