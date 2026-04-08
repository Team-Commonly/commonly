import mongoose, { Document, Schema, Types } from 'mongoose';

export type AgentTemplateVisibility = 'private' | 'public';

export interface IAgentTemplate extends Document {
  agentName: string;
  displayName: string;
  description: string;
  iconUrl: string;
  visibility: AgentTemplateVisibility;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const AgentTemplateSchema = new Schema<IAgentTemplate>(
  {
    agentName: { type: String, required: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    iconUrl: { type: String, default: '', trim: true },
    visibility: { type: String, enum: ['private', 'public'], default: 'private' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

AgentTemplateSchema.index({ agentName: 1, visibility: 1 });
AgentTemplateSchema.index({ createdBy: 1, visibility: 1 });

export default mongoose.model<IAgentTemplate>('AgentTemplate', AgentTemplateSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
