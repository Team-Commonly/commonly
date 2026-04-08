import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type AppStatus = 'active' | 'disabled';
export type AppType = 'webhook' | 'agent' | 'integration';
export type AppConnectionType = 'stdio' | 'http' | 'websocket';
export type AppCategory = 'productivity' | 'development' | 'analytics' | 'support' | 'communication' | 'other';

export interface IAppTool {
  name?: string;
  description?: string;
  inputSchema?: mongoose.Schema.Types.Mixed;
}

export interface IAppResource {
  uri?: string;
  name?: string;
  mimeType?: string;
}

export interface IApp extends Document {
  name: string;
  description: string;
  homepage: string;
  callbackUrl: string;
  webhookUrl: string;
  webhookSecretHash: string;
  clientId: string;
  clientSecretHash: string;
  ownerId: Types.ObjectId;
  allowedRedirects: string[];
  defaultScopes: string[];
  allowedEvents: string[];
  status: AppStatus;
  type: AppType;
  agent: {
    displayName?: string;
    avatar?: string;
    purpose?: string;
    capabilities?: string[];
    mcpEndpoint?: string;
    connectionType?: AppConnectionType;
    tools?: IAppTool[];
    resources?: IAppResource[];
  };
  marketplace: {
    published: boolean;
    category: AppCategory;
    tags: string[];
    logo?: string;
    screenshots: string[];
    verified: boolean;
    rating: number;
    ratingCount: number;
    installCount: number;
  };
  stats: {
    totalInstalls: number;
    activeInstalls: number;
    webhooksDelivered: number;
    lastActivity?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
  recordInstall(): Promise<void>;
  recordUninstall(): Promise<void>;
}

export interface IAppModel extends Model<IApp> {
  findPublished(options?: { category?: string; type?: string; limit?: number }): mongoose.Query<IApp[], IApp>;
}

const AppSchema = new Schema<IApp>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    homepage: { type: String, default: '' },
    callbackUrl: { type: String, default: '' },
    webhookUrl: { type: String, required: true },
    webhookSecretHash: { type: String, required: true },
    clientId: { type: String, required: true, unique: true },
    clientSecretHash: { type: String, required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    allowedRedirects: [{ type: String }],
    defaultScopes: [{ type: String }],
    allowedEvents: [{ type: String }],
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    type: { type: String, enum: ['webhook', 'agent', 'integration'], default: 'webhook' },
    agent: {
      displayName: { type: String },
      avatar: { type: String },
      purpose: { type: String },
      capabilities: [{ type: String }],
      mcpEndpoint: { type: String },
      connectionType: {
        type: String,
        enum: ['stdio', 'http', 'websocket'],
        default: 'http',
      },
      tools: [
        {
          name: { type: String },
          description: { type: String },
          inputSchema: { type: Schema.Types.Mixed },
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
    stats: {
      totalInstalls: { type: Number, default: 0 },
      activeInstalls: { type: Number, default: 0 },
      webhooksDelivered: { type: Number, default: 0 },
      lastActivity: { type: Date },
    },
  },
  { timestamps: true, collection: 'apps' },
);

AppSchema.index({ 'marketplace.published': 1, 'marketplace.category': 1 });
AppSchema.index({ name: 'text', description: 'text', 'agent.purpose': 'text' });

AppSchema.statics.findPublished = function (
  options: { category?: string; type?: string; limit?: number } = {},
) {
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

AppSchema.methods.recordInstall = async function (): Promise<void> {
  this.stats.totalInstalls += 1;
  this.stats.activeInstalls += 1;
  this.marketplace.installCount += 1;
  this.stats.lastActivity = new Date();
  await this.save();
};

AppSchema.methods.recordUninstall = async function (): Promise<void> {
  this.stats.activeInstalls = Math.max(0, this.stats.activeInstalls - 1);
  await this.save();
};

export default mongoose.model<IApp, IAppModel>('App', AppSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
