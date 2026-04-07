import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IAgentMemory extends Document {
  agentName: string;
  instanceId: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

const agentMemorySchema = new Schema<IAgentMemory>(
  {
    agentName: { type: String, required: true },
    instanceId: { type: String, default: 'default' },
    content: { type: String, default: '' },
  },
  { timestamps: true },
);

agentMemorySchema.index({ agentName: 1, instanceId: 1 }, { unique: true });

const AgentMemory: Model<IAgentMemory> =
  (mongoose.models.AgentMemory as Model<IAgentMemory>) ||
  mongoose.model<IAgentMemory>('AgentMemory', agentMemorySchema);

export default AgentMemory;
