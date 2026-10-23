import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * Durable record that a human and an agent have already met. Hosted greeting
 * pod ids are added atomically; the identity and first-pod fields never move.
 * It intentionally outlives AgentInstallation rows so uninstall/reinstall
 * cannot replay onboarding for an existing relationship (ADR-001 identity
 * continuity).
 */
export interface IAgentFirstContact extends Document {
  userId: Types.ObjectId;
  agentName: string;
  instanceId: string;
  firstPodId: Types.ObjectId;
  /** Pods whose hosted greeting was considered under the current policy. */
  greetedPodIds?: Types.ObjectId[];
  createdAt: Date;
}

const AgentFirstContactSchema = new Schema<IAgentFirstContact>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    agentName: { type: String, required: true, lowercase: true, trim: true },
    instanceId: { type: String, required: true, lowercase: true, trim: true },
    firstPodId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    greetedPodIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

AgentFirstContactSchema.index(
  { userId: 1, agentName: 1, instanceId: 1 },
  { unique: true },
);

const AgentFirstContact: Model<IAgentFirstContact> =
  (mongoose.models.AgentFirstContact as Model<IAgentFirstContact>)
  || mongoose.model<IAgentFirstContact>('AgentFirstContact', AgentFirstContactSchema);

export default AgentFirstContact;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
