/**
 * AgentProfile Model
 *
 * Defines pod-native agents with their personas, capabilities, and policies.
 * Each pod can have multiple agents with different roles (assistant, moderator, etc.)
 */

const mongoose = require('mongoose');

const PersonaSchema = new mongoose.Schema(
  {
    tone: {
      type: String,
      enum: ['friendly', 'professional', 'casual', 'formal', 'technical'],
      default: 'friendly',
    },
    boundaries: [String], // Things the agent won't do
    specialties: [String], // What the agent is good at
    customInstructions: String, // Additional persona instructions
  },
  { _id: false },
);

const ToolPolicySchema = new mongoose.Schema(
  {
    allowed: {
      type: [String], // Allowed tool categories
      default: ['search', 'read', 'context'],
    },
    blocked: [String], // Explicitly blocked tools
    requireApproval: [String], // Tools that need human approval
  },
  { _id: false },
);

const ContextPolicySchema = new mongoose.Schema(
  {
    maxTokens: {
      type: Number,
      default: 8000,
    },
    compactionThreshold: {
      type: Number,
      default: 6000,
    },
    includeMemory: {
      type: Boolean,
      default: true,
    },
    includeSkills: {
      type: Boolean,
      default: true,
    },
    includeSummaries: {
      type: Boolean,
      default: true,
    },
    summaryHours: {
      type: Number, // How many hours of summaries to include
      default: 24,
    },
  },
  { _id: false },
);

const AgentProfileSchema = new mongoose.Schema(
  {
    // Unique agent identifier within the pod
    agentId: {
      type: String,
      required: true,
    },

    // Registry agent name (e.g., commonly-ai-agent)
    agentName: {
      type: String,
      required: true,
    },

    // Optional instance id for multiple installs
    instanceId: {
      type: String,
      default: 'default',
    },

    // Pod this agent belongs to
    podId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
    },

    // Display name
    name: {
      type: String,
      required: true,
    },

    // Agent's role/purpose
    purpose: {
      type: String,
      required: true,
    },

    // System prompt additions
    instructions: {
      type: String,
      default: '',
    },

    // Persona configuration
    persona: {
      type: PersonaSchema,
      default: () => ({}),
    },

    // Tool access policy
    toolPolicy: {
      type: ToolPolicySchema,
      default: () => ({}),
    },

    // Context assembly policy
    contextPolicy: {
      type: ContextPolicySchema,
      default: () => ({}),
    },

    // Allowed integration sources
    integrations: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Integration',
      },
    ],

    // Model preferences
    modelPreferences: {
      preferred: {
        type: String,
        default: 'gemini-2.5-pro',
      },
      fallback: {
        type: String,
        default: 'gemini-2.5-flash',
      },
    },

    // Agent state
    status: {
      type: String,
      enum: ['active', 'paused', 'archived'],
      default: 'active',
    },

    // Is this the default agent for the pod?
    isDefault: {
      type: Boolean,
      default: false,
    },

    // Who created this agent
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Heartbeat file content — mirrors the agent's /workspace/{instanceId}/HEARTBEAT.md
    // Synced when heartbeat-file endpoint writes to PVC, and seeded on provision from preset template.
    heartbeatContent: {
      type: String,
      default: '',
    },

    // Usage statistics
    stats: {
      totalSessions: { type: Number, default: 0 },
      totalMessages: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
      lastActiveAt: Date,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for unique agentId per pod
AgentProfileSchema.index({ podId: 1, agentId: 1 }, { unique: true });
AgentProfileSchema.index({ podId: 1, agentName: 1, instanceId: 1 }, { unique: true });
AgentProfileSchema.index({ podId: 1, status: 1 });
AgentProfileSchema.index({ podId: 1, isDefault: 1 });

// Static methods
AgentProfileSchema.statics.findByPodAndId = function (podId, agentId) {
  return this.findOne({ podId, agentId });
};

AgentProfileSchema.statics.getDefaultAgent = function (podId) {
  return this.findOne({ podId, isDefault: true, status: 'active' });
};

AgentProfileSchema.statics.getActiveAgents = function (podId) {
  return this.find({ podId, status: 'active' }).sort({ isDefault: -1, name: 1 });
};

AgentProfileSchema.statics.createDefaultAgent = async function (podId, createdBy, podName) {
  const existing = await this.findOne({ podId, isDefault: true });
  if (existing) return existing;

  return this.create({
    agentId: 'pod-assistant',
    agentName: 'pod-assistant',
    instanceId: 'default',
    podId,
    name: `${podName} Assistant`,
    purpose: `AI assistant for the ${podName} pod. Helps members with questions, searches pod knowledge, and facilitates discussions.`,
    instructions: `You are the assistant for ${podName}. Use the pod's memory, skills, and recent summaries to provide helpful, contextual responses.`,
    isDefault: true,
    createdBy,
    persona: {
      tone: 'friendly',
      specialties: ['answering questions', 'searching knowledge', 'summarizing discussions'],
    },
  });
};

// Instance methods
AgentProfileSchema.methods.buildSystemPrompt = function () {
  let prompt = `${this.purpose}\n\n`;

  if (this.instructions) {
    prompt += `${this.instructions}\n\n`;
  }

  if (this.persona.customInstructions) {
    prompt += `${this.persona.customInstructions}\n\n`;
  }

  if (this.persona.tone) {
    prompt += `Communication style: ${this.persona.tone}\n`;
  }

  if (this.persona.specialties?.length > 0) {
    prompt += `Specialties: ${this.persona.specialties.join(', ')}\n`;
  }

  if (this.persona.boundaries?.length > 0) {
    prompt += '\nBoundaries (do not):\n';
    this.persona.boundaries.forEach((b) => {
      prompt += `- ${b}\n`;
    });
  }

  return prompt;
};

AgentProfileSchema.methods.canUseTool = function (toolName) {
  // Check if blocked
  if (this.toolPolicy.blocked?.includes(toolName)) {
    return { allowed: false, reason: 'blocked' };
  }

  // Check if in allowed categories
  const toolCategory = toolName.split('_')[0]; // e.g., commonly_search -> commonly
  if (this.toolPolicy.allowed?.includes(toolCategory) || this.toolPolicy.allowed?.includes(toolName)) {
    // Check if requires approval
    if (this.toolPolicy.requireApproval?.includes(toolName)) {
      return { allowed: true, requiresApproval: true };
    }
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

module.exports = mongoose.model('AgentProfile', AgentProfileSchema);
