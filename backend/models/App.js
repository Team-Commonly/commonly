const mongoose = require('mongoose');

const AppSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    homepage: { type: String, default: '' },
    callbackUrl: { type: String, default: '' },
    webhookUrl: { type: String, required: true },
    webhookSecretHash: { type: String, required: true },
    clientId: { type: String, required: true, unique: true },
    clientSecretHash: { type: String, required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    allowedRedirects: [{ type: String }],
    defaultScopes: [{ type: String }],
    allowedEvents: [{ type: String }],
    status: {
      type: String,
      enum: ['active', 'disabled'],
      default: 'active',
    },

    // Agent-specific fields (for AI agent apps)
    type: {
      type: String,
      enum: ['webhook', 'agent', 'integration'],
      default: 'webhook',
    },

    // Agent manifest (for type: 'agent')
    agent: {
      displayName: { type: String },
      avatar: { type: String },
      purpose: { type: String },
      capabilities: [{ type: String }],
      mcpEndpoint: { type: String }, // MCP server endpoint
      connectionType: {
        type: String,
        enum: ['stdio', 'http', 'websocket'],
        default: 'http',
      },
      tools: [
        {
          name: { type: String },
          description: { type: String },
          inputSchema: { type: mongoose.Schema.Types.Mixed },
        },
      ],
      resources: [
        {
          uri: { type: String },
          name: { type: String },
          mimeType: { type: String },
        },
      ],
    },

    // Marketplace fields
    marketplace: {
      published: { type: Boolean, default: false },
      category: {
        type: String,
        enum: ['productivity', 'development', 'analytics', 'support', 'communication', 'other'],
        default: 'other',
      },
      tags: [{ type: String }],
      logo: { type: String },
      screenshots: [{ type: String }],
      verified: { type: Boolean, default: false },
      rating: { type: Number, default: 0 },
      ratingCount: { type: Number, default: 0 },
      installCount: { type: Number, default: 0 },
    },

    // Usage stats
    stats: {
      totalInstalls: { type: Number, default: 0 },
      activeInstalls: { type: Number, default: 0 },
      webhooksDelivered: { type: Number, default: 0 },
      lastActivity: { type: Date },
    },
  },
  {
    timestamps: true,
    collection: 'apps',
  },
);

// Index for marketplace search
AppSchema.index({ 'marketplace.published': 1, 'marketplace.category': 1 });
AppSchema.index({ name: 'text', description: 'text', 'agent.purpose': 'text' });

// Static: Find published apps
AppSchema.statics.findPublished = function (options = {}) {
  const query = this.find({ 'marketplace.published': true, status: 'active' });
  if (options.category && options.category !== 'all') {
    query.where('marketplace.category', options.category);
  }
  if (options.type) {
    query.where('type', options.type);
  }
  return query
    .select('-clientSecretHash -webhookSecretHash -tokenHash')
    .sort({ 'marketplace.installCount': -1 })
    .limit(options.limit || 50);
};

// Instance: Increment install count
AppSchema.methods.recordInstall = async function () {
  this.stats.totalInstalls += 1;
  this.stats.activeInstalls += 1;
  this.marketplace.installCount += 1;
  this.stats.lastActivity = new Date();
  await this.save();
};

// Instance: Record uninstall
AppSchema.methods.recordUninstall = async function () {
  this.stats.activeInstalls = Math.max(0, this.stats.activeInstalls - 1);
  await this.save();
};

module.exports = mongoose.model('App', AppSchema);
