/**
 * Agent Registry Model
 *
 * The "package manager" for AI agents. Tracks installed agents, their manifests,
 * versions, and installations per pod.
 *
 * This is the foundation of Commonly as an "AI Agent Distribution Platform".
 */

const mongoose = require('mongoose');

// Agent Manifest Schema (like package.json for agents)
const ManifestCapabilitySchema = new mongoose.Schema(
  {
    name: String,
    description: String,
  },
  { _id: false },
);

const ManifestContextSchema = new mongoose.Schema(
  {
    required: [String], // Required scopes
    optional: [String], // Optional scopes
  },
  { _id: false },
);

const ManifestRuntimeSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['standalone', 'commonly-hosted', 'hybrid'],
      default: 'standalone',
    },
    connection: {
      type: String,
      enum: ['mcp', 'rest', 'websocket'],
      default: 'mcp',
    },
    minMemory: String,
    ports: {
      type: Map,
      of: Number,
    },
  },
  { _id: false },
);

const ManifestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    version: { type: String, required: true },
    description: String,
    author: String,
    license: String,
    homepage: String,
    repository: String,
    capabilities: [ManifestCapabilitySchema],
    context: ManifestContextSchema,
    integrations: {
      supported: [String],
      required: [String],
    },
    models: {
      supported: [String],
      recommended: String,
    },
    runtime: ManifestRuntimeSchema,
    configSchema: mongoose.Schema.Types.Mixed, // JSON Schema for agent config
    hooks: {
      postInstall: String,
      preUpdate: String,
      postUpdate: String,
    },
  },
  { _id: false },
);

// Agent Registry Entry (published agents)
const AgentRegistrySchema = new mongoose.Schema(
  {
    // Unique agent identifier (like npm package name)
    agentName: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      match: /^[a-z0-9-]+$/,
    },

    // Display name
    displayName: {
      type: String,
      required: true,
    },

    // Short description
    description: {
      type: String,
      required: true,
    },

    // Long description (markdown)
    readme: String,

    // Agent manifest
    manifest: {
      type: ManifestSchema,
      required: true,
    },

    // Available versions
    versions: [
      {
        version: String,
        manifest: ManifestSchema,
        publishedAt: Date,
        deprecated: Boolean,
        deprecationReason: String,
      },
    ],

    // Current latest version
    latestVersion: String,

    // Registry source
    registry: {
      type: String,
      enum: ['commonly-official', 'commonly-community', 'private'],
      default: 'commonly-community',
    },

    // Verification status
    verified: {
      type: Boolean,
      default: false,
    },

    // Publisher information
    publisher: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      organizationId: mongoose.Schema.Types.ObjectId,
      name: String,
    },

    // Categories/tags for discovery
    categories: [String],
    tags: [String],

    // Statistics
    stats: {
      installs: { type: Number, default: 0 },
      weeklyInstalls: { type: Number, default: 0 },
      rating: { type: Number, default: 0 },
      ratingCount: { type: Number, default: 0 },
    },

    // Status
    status: {
      type: String,
      enum: ['active', 'deprecated', 'unpublished', 'pending-review'],
      default: 'active',
    },

    // Icon/logo URL
    iconUrl: String,
  },
  {
    timestamps: true,
  },
);

// Indexes
AgentRegistrySchema.index({ categories: 1 });
AgentRegistrySchema.index({ tags: 1 });
AgentRegistrySchema.index({ 'stats.installs': -1 });
AgentRegistrySchema.index({ registry: 1, status: 1 });
AgentRegistrySchema.index({ 'publisher.userId': 1 });

// Text search index
AgentRegistrySchema.index({
  agentName: 'text',
  displayName: 'text',
  description: 'text',
  tags: 'text',
});

// Static methods
AgentRegistrySchema.statics.search = function (query, options = {}) {
  const {
    limit = 20, offset = 0, category = null, registry = null, verified = null,
  } = options;

  const filter = {
    status: 'active',
  };

  if (query) {
    filter.$text = { $search: query };
  }

  if (category) {
    filter.categories = category;
  }

  if (registry) {
    filter.registry = registry;
  }

  if (verified !== null) {
    filter.verified = verified;
  }

  return this.find(filter)
    .sort(query ? { score: { $meta: 'textScore' } } : { 'stats.installs': -1 })
    .skip(offset)
    .limit(limit)
    .lean();
};

AgentRegistrySchema.statics.getByName = function (agentName) {
  return this.findOne({ agentName: agentName.toLowerCase() });
};

AgentRegistrySchema.statics.incrementInstalls = async function (agentName) {
  return this.updateOne(
    { agentName: agentName.toLowerCase() },
    {
      $inc: {
        'stats.installs': 1,
        'stats.weeklyInstalls': 1,
      },
    },
  );
};

// Agent Installation Model (per-pod installations)
const AgentInstallationSchema = new mongoose.Schema(
  {
    // Reference to registry entry
    agentName: {
      type: String,
      required: true,
      lowercase: true,
    },

    // Pod where agent is installed
    podId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
    },

    // Optional instance identifier to allow multiple installs per pod
    instanceId: {
      type: String,
      default: 'default',
    },

    // Human-friendly instance name (for UI display)
    displayName: {
      type: String,
    },

    // Installed version
    version: {
      type: String,
      required: true,
    },

    // Installation configuration
    config: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
    },

    // Granted scopes
    scopes: [String],

    // Installation status
    status: {
      type: String,
      enum: ['active', 'paused', 'uninstalled', 'error'],
      default: 'active',
    },

    // Error details if status is error
    errorMessage: String,

    // Who installed
    installedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Usage statistics
    usage: {
      lastUsedAt: Date,
      totalCalls: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
    },

    // Runtime access tokens for external agent services
    runtimeTokens: [
      {
        tokenHash: String,
        label: String,
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: Date,
      },
    ],
  },
  {
    timestamps: true,
  },
);

// Compound index for unique installation per pod
AgentInstallationSchema.index({ agentName: 1, podId: 1, instanceId: 1 }, { unique: true });
AgentInstallationSchema.index({ podId: 1, status: 1 });

// Static methods
AgentInstallationSchema.statics.getInstalledAgents = function (podId) {
  return this.find({ podId, status: 'active' }).lean();
};

AgentInstallationSchema.statics.isInstalled = async function (agentName, podId, instanceId = 'default') {
  const installation = await this.findOne({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId,
    status: 'active',
  });
  return !!installation;
};

AgentInstallationSchema.statics.install = async function (agentName, podId, options) {
  const {
    version, config, scopes, installedBy, instanceId = 'default', displayName,
  } = options;

  // Check if already installed
  const existing = await this.findOne({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId,
  });

  if (existing) {
    if (existing.status === 'active') {
      throw new Error('Agent already installed');
    }
    // Reactivate uninstalled agent
    existing.status = 'active';
    existing.version = version;
    existing.config = config;
    existing.scopes = scopes;
    return existing.save();
  }

  return this.create({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId,
    displayName,
    version,
    config,
    scopes,
    installedBy,
  });
};

AgentInstallationSchema.statics.uninstall = async function (agentName, podId, instanceId = 'default') {
  return this.updateOne(
    {
      agentName: agentName.toLowerCase(),
      podId,
      instanceId,
    },
    {
      status: 'uninstalled',
    },
  );
};

// Instance methods
AgentInstallationSchema.methods.recordUsage = async function (tokens = 0) {
  this.usage.lastUsedAt = new Date();
  this.usage.totalCalls += 1;
  this.usage.totalTokens += tokens;
  return this.save();
};

const AgentRegistry = mongoose.model('AgentRegistry', AgentRegistrySchema);
const AgentInstallation = mongoose.model('AgentInstallation', AgentInstallationSchema);

module.exports = { AgentRegistry, AgentInstallation };
