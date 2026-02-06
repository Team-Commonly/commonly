const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  verified: { type: Boolean, default: false },
  profilePicture: { type: String, default: 'default' },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  apiToken: { type: String, unique: true, sparse: true },
  apiTokenCreatedAt: { type: Date },
  apiTokenScopes: [{ type: String }],

  // Bot/Agent user properties
  isBot: { type: Boolean, default: false },
  botType: {
    type: String,
    enum: ['system', 'agent', 'bridge', null],
    default: null,
  },
  botMetadata: {
    displayName: { type: String }, // Cute display name like "Clawd 🐾"
    description: { type: String }, // Bot description
    runtimeId: { type: String }, // Unique runtime instance identifier
    officialAgent: { type: Boolean, default: false }, // Is this an official Commonly agent?
    capabilities: [{ type: String }], // e.g., ['chat', 'summarize', 'memory']
    agentName: { type: String }, // Registry agent name (e.g., commonly-ai-agent)
    instanceId: { type: String }, // Instance id for multi-install
  },

  // Agent avatar metadata (for AI-generated avatars)
  avatarMetadata: {
    style: {
      type: String,
      enum: ['banana', 'abstract', 'minimalist', 'cartoon', 'geometric', 'custom'],
    },
    personality: {
      type: String,
      enum: ['friendly', 'professional', 'playful', 'wise', 'creative'],
    },
    colorScheme: {
      type: String,
      enum: ['vibrant', 'pastel', 'monochrome', 'neon'],
    },
    generatedAt: { type: Date },
    prompt: { type: String }, // AI prompt used to generate avatar
  },

  // Agent personality configuration
  agentConfig: {
    personality: {
      tone: {
        type: String,
        enum: ['friendly', 'professional', 'sarcastic', 'educational', 'humorous'],
        default: 'friendly',
      },
      interests: [{
        type: String,
        trim: true,
      }],
      behavior: {
        type: String,
        enum: ['reactive', 'proactive', 'balanced'],
        default: 'reactive',
      },
      responseStyle: {
        type: String,
        enum: ['concise', 'detailed', 'conversational'],
        default: 'conversational',
      },
    },
    systemPrompt: {
      type: String,
      default: 'You are a helpful AI assistant.',
    },
    capabilities: [{
      type: String,
      enum: ['chat', 'summarize', 'curate', 'moderate', 'translate'],
    }],
  },

  // Agent runtime tokens (shared across all pod installations)
  agentRuntimeTokens: [
    {
      tokenHash: { type: String, required: true },
      label: { type: String },
      createdAt: { type: Date, default: Date.now },
      lastUsedAt: { type: Date },
    },
  ],

  // Daily digest and subscription preferences
  subscribedPods: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
    },
  ],
  digestPreferences: {
    enabled: { type: Boolean, default: true },
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'never'],
      default: 'daily',
    },
    deliveryTime: { type: String, default: '06:00' }, // UTC time in HH:MM format
    includeQuotes: { type: Boolean, default: true },
    includeInsights: { type: Boolean, default: true },
    includeTimeline: { type: Boolean, default: true },
    minActivityLevel: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'low',
    },
  },

  // Activity tracking for digest relevance
  lastActive: { type: Date, default: Date.now },
  lastDigestSent: { type: Date },

  createdAt: { type: Date, default: Date.now },
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function (password) {
  return bcrypt.compare(password, this.password);
};

userSchema.methods.generateApiToken = function () {
  this.apiToken = `cm_${crypto.randomBytes(32).toString('hex')}`;
  this.apiTokenCreatedAt = new Date();
  return this.apiToken;
};

userSchema.methods.revokeApiToken = function () {
  this.apiToken = undefined;
  this.apiTokenCreatedAt = undefined;
};

module.exports = mongoose.model('User', userSchema);
