import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type RegistryType = 'commonly-official' | 'commonly-community' | 'private';
export type RegistryStatus = 'active' | 'deprecated' | 'unpublished' | 'pending-review';
export type ManifestRuntimeType = 'standalone' | 'commonly-hosted' | 'hybrid';
export type ManifestConnectionType = 'mcp' | 'rest' | 'websocket';
export type AgentInstallationStatus = 'active' | 'paused' | 'uninstalled' | 'error';

export interface IManifestCapability {
  name?: string;
  description?: string;
}

export interface IManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  capabilities?: IManifestCapability[];
  context?: { required?: string[]; optional?: string[] };
  integrations?: { supported?: string[]; required?: string[] };
  models?: { supported?: string[]; recommended?: string };
  runtime?: {
    type?: ManifestRuntimeType;
    connection?: ManifestConnectionType;
    minMemory?: string;
    ports?: Map<string, number>;
  };
  configSchema?: unknown;
  hooks?: { postInstall?: string; preUpdate?: string; postUpdate?: string };
}

export interface IAgentRegistry extends Document {
  agentName: string;
  displayName: string;
  description: string;
  readme?: string;
  manifest: IManifest;
  versions: Array<{
    version?: string;
    manifest?: IManifest;
    publishedAt?: Date;
    deprecated?: boolean;
    deprecationReason?: string;
  }>;
  latestVersion?: string;
  registry: RegistryType;
  verified: boolean;
  publisher: {
    userId?: Types.ObjectId;
    organizationId?: Types.ObjectId;
    name?: string;
  };
  categories: string[];
  tags: string[];
  stats: {
    installs: number;
    weeklyInstalls: number;
    rating: number;
    ratingCount: number;
  };
  status: RegistryStatus;
  iconUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgentRegistryModel extends Model<IAgentRegistry> {
  search(query: string, options?: { limit?: number; offset?: number; category?: string | null; registry?: string | null; verified?: boolean | null }): mongoose.Query<IAgentRegistry[], IAgentRegistry>;
  getByName(agentName: string): mongoose.Query<IAgentRegistry | null, IAgentRegistry>;
  incrementInstalls(agentName: string): Promise<mongoose.UpdateWriteOpResult>;
}

const ManifestCapabilitySchema = new Schema({ name: String, description: String }, { _id: false });
const ManifestContextSchema = new Schema({ required: [String], optional: [String] }, { _id: false });
const ManifestRuntimeSchema = new Schema(
  {
    type: { type: String, enum: ['standalone', 'commonly-hosted', 'hybrid'], default: 'standalone' },
    connection: { type: String, enum: ['mcp', 'rest', 'websocket'], default: 'mcp' },
    minMemory: String,
    ports: { type: Map, of: Number },
  },
  { _id: false },
);

const ManifestSchema = new Schema(
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
    integrations: { supported: [String], required: [String] },
    models: { supported: [String], recommended: String },
    runtime: ManifestRuntimeSchema,
    configSchema: Schema.Types.Mixed,
    hooks: { postInstall: String, preUpdate: String, postUpdate: String },
  },
  { _id: false },
);

const AgentRegistrySchema = new Schema<IAgentRegistry>(
  {
    agentName: { type: String, required: true, unique: true, lowercase: true, match: /^[a-z0-9-]+$/ },
    displayName: { type: String, required: true },
    description: { type: String, required: true },
    readme: String,
    manifest: { type: ManifestSchema, required: true },
    versions: [
      {
        version: String,
        manifest: ManifestSchema,
        publishedAt: Date,
        deprecated: Boolean,
        deprecationReason: String,
      },
    ],
    latestVersion: String,
    registry: { type: String, enum: ['commonly-official', 'commonly-community', 'private'], default: 'commonly-community' },
    verified: { type: Boolean, default: false },
    publisher: {
      userId: { type: Schema.Types.ObjectId, ref: 'User' },
      organizationId: Schema.Types.ObjectId,
      name: String,
    },
    categories: [String],
    tags: [String],
    stats: {
      installs: { type: Number, default: 0 },
      weeklyInstalls: { type: Number, default: 0 },
      rating: { type: Number, default: 0 },
      ratingCount: { type: Number, default: 0 },
    },
    status: { type: String, enum: ['active', 'deprecated', 'unpublished', 'pending-review'], default: 'active' },
    iconUrl: String,
  },
  { timestamps: true },
);

AgentRegistrySchema.index({ categories: 1 });
AgentRegistrySchema.index({ tags: 1 });
AgentRegistrySchema.index({ 'stats.installs': -1 });
AgentRegistrySchema.index({ registry: 1, status: 1 });
AgentRegistrySchema.index({ 'publisher.userId': 1 });
AgentRegistrySchema.index({ agentName: 'text', displayName: 'text', description: 'text', tags: 'text' });

AgentRegistrySchema.statics.search = function (
  query: string,
  options: { limit?: number; offset?: number; category?: string | null; registry?: string | null; verified?: boolean | null } = {},
) {
  const { limit = 20, offset = 0, category = null, registry = null, verified = null } = options;
  const filter: Record<string, unknown> = { status: 'active' };
  if (query) filter.$text = { $search: query };
  if (category) filter.categories = category;
  if (registry) filter.registry = registry;
  if (verified !== null) filter.verified = verified;
  return this.find(filter)
    .sort(query ? { score: { $meta: 'textScore' } } : { 'stats.installs': -1 })
    .skip(offset)
    .limit(limit)
    .lean();
};

AgentRegistrySchema.statics.getByName = function (agentName: string) {
  return this.findOne({ agentName: agentName.toLowerCase() });
};

AgentRegistrySchema.statics.incrementInstalls = async function (agentName: string) {
  return this.updateOne(
    { agentName: agentName.toLowerCase() },
    { $inc: { 'stats.installs': 1, 'stats.weeklyInstalls': 1 } },
  );
};

// --- AgentInstallation (per-pod registry agent installations) ---

export interface IAgentInstallationRegistry extends Document {
  agentName: string;
  podId: Types.ObjectId;
  instanceId: string;
  displayName?: string;
  version: string;
  config?: Map<string, unknown>;
  scopes: string[];
  status: AgentInstallationStatus;
  errorMessage?: string;
  installedBy: Types.ObjectId;
  usage: {
    lastUsedAt?: Date;
    totalCalls: number;
    totalTokens: number;
  };
  runtimeTokens: Array<{
    tokenHash?: string;
    label?: string;
    createdAt: Date;
    lastUsedAt?: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
  recordUsage(tokens?: number): Promise<IAgentInstallationRegistry>;
}

export interface IAgentInstallationRegistryModel extends Model<IAgentInstallationRegistry> {
  getInstalledAgents(podId: Types.ObjectId): mongoose.Query<IAgentInstallationRegistry[], IAgentInstallationRegistry>;
  isInstalled(agentName: string, podId: Types.ObjectId, instanceId?: string): Promise<boolean>;
  install(agentName: string, podId: Types.ObjectId, options: { version: string; config?: Map<string, unknown>; scopes?: string[]; installedBy: Types.ObjectId; instanceId?: string; displayName?: string }): Promise<IAgentInstallationRegistry>;
  uninstall(agentName: string, podId: Types.ObjectId, instanceId?: string): Promise<mongoose.UpdateWriteOpResult>;
}

const AgentInstallationSchema = new Schema<IAgentInstallationRegistry>(
  {
    agentName: { type: String, required: true, lowercase: true },
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    instanceId: { type: String, default: 'default' },
    displayName: { type: String },
    version: { type: String, required: true },
    config: { type: Map, of: Schema.Types.Mixed },
    scopes: [String],
    status: { type: String, enum: ['active', 'paused', 'uninstalled', 'error'], default: 'active' },
    errorMessage: String,
    installedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    usage: {
      lastUsedAt: Date,
      totalCalls: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
    },
    runtimeTokens: [
      {
        tokenHash: String,
        label: String,
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: Date,
      },
    ],
  },
  { timestamps: true },
);

AgentInstallationSchema.index({ agentName: 1, podId: 1, instanceId: 1 }, { unique: true });
AgentInstallationSchema.index({ podId: 1, status: 1 });

AgentInstallationSchema.statics.getInstalledAgents = function (podId: Types.ObjectId) {
  return this.find({ podId, status: 'active' }).lean();
};

AgentInstallationSchema.statics.isInstalled = async function (agentName: string, podId: Types.ObjectId, instanceId = 'default') {
  const installation = await this.findOne({ agentName: agentName.toLowerCase(), podId, instanceId, status: 'active' });
  return !!installation;
};

AgentInstallationSchema.statics.install = async function (agentName: string, podId: Types.ObjectId, options: {
  version: string;
  config?: Map<string, unknown>;
  scopes?: string[];
  installedBy: Types.ObjectId;
  instanceId?: string;
  displayName?: string;
}) {
  const { version, config, scopes, installedBy, instanceId = 'default', displayName } = options;
  const existing = await this.findOne({ agentName: agentName.toLowerCase(), podId, instanceId });
  if (existing) {
    if (existing.status === 'active') throw new Error('Agent already installed');
    existing.status = 'active';
    existing.version = version;
    existing.config = config;
    existing.scopes = scopes;
    return existing.save();
  }
  return this.create({ agentName: agentName.toLowerCase(), podId, instanceId, displayName, version, config, scopes, installedBy });
};

AgentInstallationSchema.statics.uninstall = async function (agentName: string, podId: Types.ObjectId, instanceId = 'default') {
  return this.updateOne({ agentName: agentName.toLowerCase(), podId, instanceId }, { status: 'uninstalled' });
};

AgentInstallationSchema.methods.recordUsage = async function (tokens = 0) {
  this.usage.lastUsedAt = new Date();
  this.usage.totalCalls += 1;
  this.usage.totalTokens += tokens;
  return this.save();
};

export const AgentRegistry = mongoose.model<IAgentRegistry, IAgentRegistryModel>('AgentRegistry', AgentRegistrySchema);
export const AgentInstallation = mongoose.model<IAgentInstallationRegistry, IAgentInstallationRegistryModel>('AgentInstallation', AgentInstallationSchema);
