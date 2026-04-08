import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type AgentProfileTone = 'friendly' | 'professional' | 'casual' | 'formal' | 'technical';
export type AgentProfileStatus = 'active' | 'paused' | 'archived';

export interface IAgentProfilePersona {
  tone: AgentProfileTone;
  boundaries?: string[];
  specialties?: string[];
  customInstructions?: string;
}

export interface IToolPolicy {
  allowed: string[];
  blocked?: string[];
  requireApproval?: string[];
}

export interface IContextPolicy {
  maxTokens: number;
  compactionThreshold: number;
  includeMemory: boolean;
  includeSkills: boolean;
  includeSummaries: boolean;
  summaryHours: number;
}

export interface IAgentProfile extends Document {
  agentId: string;
  agentName: string;
  instanceId: string;
  podId: Types.ObjectId;
  name: string;
  purpose: string;
  instructions: string;
  persona: IAgentProfilePersona;
  toolPolicy: IToolPolicy;
  contextPolicy: IContextPolicy;
  integrations: Types.ObjectId[];
  modelPreferences: {
    preferred: string;
    fallback: string;
  };
  status: AgentProfileStatus;
  isDefault: boolean;
  createdBy: Types.ObjectId;
  heartbeatContent: string;
  stats: {
    totalSessions: number;
    totalMessages: number;
    totalTokens: number;
    lastActiveAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
  buildSystemPrompt(): string;
  canUseTool(toolName: string): { allowed: boolean; reason?: string; requiresApproval?: boolean };
  incrementStats(messages?: number, tokens?: number): Promise<IAgentProfile>;
}

export interface IAgentProfileModel extends Model<IAgentProfile> {
  findByPodAndId(podId: Types.ObjectId, agentId: string): mongoose.Query<IAgentProfile | null, IAgentProfile>;
  getDefaultAgent(podId: Types.ObjectId): mongoose.Query<IAgentProfile | null, IAgentProfile>;
  getActiveAgents(podId: Types.ObjectId): mongoose.Query<IAgentProfile[], IAgentProfile>;
  createDefaultAgent(podId: Types.ObjectId, createdBy: Types.ObjectId, podName: string): Promise<IAgentProfile>;
}

const PersonaSchema = new Schema(
  {
    tone: {
      type: String,
      enum: ['friendly', 'professional', 'casual', 'formal', 'technical'],
      default: 'friendly',
    },
    boundaries: [String],
    specialties: [String],
    customInstructions: String,
  },
  { _id: false },
);

const ToolPolicySchema = new Schema(
  {
    allowed: { type: [String], default: ['search', 'read', 'context'] },
    blocked: [String],
    requireApproval: [String],
  },
  { _id: false },
);

const ContextPolicySchema = new Schema(
  {
    maxTokens: { type: Number, default: 8000 },
    compactionThreshold: { type: Number, default: 6000 },
    includeMemory: { type: Boolean, default: true },
    includeSkills: { type: Boolean, default: true },
    includeSummaries: { type: Boolean, default: true },
    summaryHours: { type: Number, default: 24 },
  },
  { _id: false },
);

const AgentProfileSchema = new Schema<IAgentProfile>(
  {
    agentId: { type: String, required: true },
    agentName: { type: String, required: true },
    instanceId: { type: String, default: 'default' },
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    name: { type: String, required: true },
    purpose: { type: String, required: true },
    instructions: { type: String, default: '' },
    persona: { type: PersonaSchema, default: () => ({}) },
    toolPolicy: { type: ToolPolicySchema, default: () => ({}) },
    contextPolicy: { type: ContextPolicySchema, default: () => ({}) },
    integrations: [{ type: Schema.Types.ObjectId, ref: 'Integration' }],
    modelPreferences: {
      preferred: { type: String, default: 'gemini-2.5-pro' },
      fallback: { type: String, default: 'gemini-2.5-flash' },
    },
    status: { type: String, enum: ['active', 'paused', 'archived'], default: 'active' },
    isDefault: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    heartbeatContent: { type: String, default: '' },
    stats: {
      totalSessions: { type: Number, default: 0 },
      totalMessages: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
      lastActiveAt: Date,
    },
  },
  { timestamps: true },
);

AgentProfileSchema.index({ podId: 1, agentId: 1 }, { unique: true });
AgentProfileSchema.index({ podId: 1, agentName: 1, instanceId: 1 }, { unique: true });
AgentProfileSchema.index({ podId: 1, status: 1 });
AgentProfileSchema.index({ podId: 1, isDefault: 1 });

AgentProfileSchema.statics.findByPodAndId = function (podId: Types.ObjectId, agentId: string) {
  return this.findOne({ podId, agentId });
};

AgentProfileSchema.statics.getDefaultAgent = function (podId: Types.ObjectId) {
  return this.findOne({ podId, isDefault: true, status: 'active' });
};

AgentProfileSchema.statics.getActiveAgents = function (podId: Types.ObjectId) {
  return this.find({ podId, status: 'active' }).sort({ isDefault: -1, name: 1 });
};

AgentProfileSchema.statics.createDefaultAgent = async function (
  podId: Types.ObjectId,
  createdBy: Types.ObjectId,
  podName: string,
) {
  const existing = await this.findOne({ podId, isDefault: true });
  if (existing) return existing;
  return this.create({
    agentId: 'pod-assistant',
    agentName: 'pod-assistant',
    instanceId: 'default',
    podId,
    name: `${podName} Assistant`,
    purpose: `AI assistant for the ${podName} pod.`,
    instructions: `You are the assistant for ${podName}. Use the pod's memory, skills, and recent summaries to provide helpful, contextual responses.`,
    isDefault: true,
    createdBy,
    persona: { tone: 'friendly', specialties: ['answering questions', 'searching knowledge', 'summarizing discussions'] },
  });
};

AgentProfileSchema.methods.buildSystemPrompt = function (): string {
  let prompt = `${this.purpose}\n\n`;
  if (this.instructions) prompt += `${this.instructions}\n\n`;
  if (this.persona.customInstructions) prompt += `${this.persona.customInstructions}\n\n`;
  if (this.persona.tone) prompt += `Communication style: ${this.persona.tone}\n`;
  if (this.persona.specialties?.length > 0) prompt += `Specialties: ${this.persona.specialties.join(', ')}\n`;
  if (this.persona.boundaries?.length > 0) {
    prompt += '\nBoundaries (do not):\n';
    this.persona.boundaries.forEach((b: string) => { prompt += `- ${b}\n`; });
  }
  return prompt;
};

AgentProfileSchema.methods.canUseTool = function (toolName: string) {
  if (this.toolPolicy.blocked?.includes(toolName)) return { allowed: false, reason: 'blocked' };
  const toolCategory = toolName.split('_')[0];
  if (this.toolPolicy.allowed?.includes(toolCategory) || this.toolPolicy.allowed?.includes(toolName)) {
    if (this.toolPolicy.requireApproval?.includes(toolName)) return { allowed: true, requiresApproval: true };
    return { allowed: true };
  }
  return { allowed: false, reason: 'not in allowed list' };
};

AgentProfileSchema.methods.incrementStats = async function (messages = 1, tokens = 0) {
  this.stats.totalMessages += messages;
  this.stats.totalTokens += tokens;
  this.stats.lastActiveAt = new Date();
  return this.save();
};

export default mongoose.model<IAgentProfile, IAgentProfileModel>('AgentProfile', AgentProfileSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
