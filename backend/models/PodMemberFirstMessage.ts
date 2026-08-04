import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * Durable record that a member has spoken in a pod at least once.
 *
 * Exists to make the first-message welcome wake (#834) fire exactly once per
 * (member, pod). The marker is deliberately its own collection rather than a
 * flag on Pod.members: membership rows are rewritten by join/leave and by the
 * dual-DB sync, and a marker that can be reset replays onboarding at someone
 * who has already been welcomed — the same reasoning that gave
 * AgentFirstContact its own collection instead of living on AgentInstallation
 * (ADR-001 identity continuity).
 *
 * Not the same thing as AgentFirstContact. That one keys
 * (userId, agentName, instanceId) and fires when a human INSTALLS an agent.
 * This keys (podId, userId) and fires when a human SPEAKS in a pod. A member
 * auto-joined to a community pod installs nothing, so first-contact never
 * fires for them — which is precisely the gap #834 reports.
 */
export interface IPodMemberFirstMessage extends Document {
  podId: Types.ObjectId;
  userId: Types.ObjectId;
  messageId?: string;
  wokeGreeter: boolean;
  createdAt: Date;
}

const PodMemberFirstMessageSchema = new Schema<IPodMemberFirstMessage>(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // The message that claimed the marker. Kept for audit: "why did this
    // member never get welcomed" is otherwise unanswerable after the fact.
    messageId: { type: String },
    // Whether the claiming message actually woke a greeter. False when the
    // first message was addressed (an @mention or a reply already routed it)
    // or when the pod designates no greeter. Recorded rather than inferred,
    // because the second case is a silent no-op we need to be able to count.
    wokeGreeter: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

// The uniqueness constraint IS the once-per-member guarantee. Two concurrent
// first messages both miss the read and both upsert; the index picks one
// winner and the loser takes a duplicate-key error, which the service treats
// as "not first" rather than as an error.
PodMemberFirstMessageSchema.index({ podId: 1, userId: 1 }, { unique: true });

const PodMemberFirstMessage: Model<IPodMemberFirstMessage> =
  (mongoose.models.PodMemberFirstMessage as Model<IPodMemberFirstMessage>)
  || mongoose.model<IPodMemberFirstMessage>('PodMemberFirstMessage', PodMemberFirstMessageSchema);

export default PodMemberFirstMessage;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
