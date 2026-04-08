import mongoose, { Document, Schema, Types } from 'mongoose';

export type IntegrationType =
  | 'discord'
  | 'telegram'
  | 'slack'
  | 'messenger'
  | 'groupme'
  | 'whatsapp'
  | 'x'
  | 'instagram';

export type IntegrationStatus = 'connected' | 'disconnected' | 'error' | 'pending';

export interface IIngestToken {
  tokenHash: string;
  label: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface IIntegrationMessageBuffer {
  messageId?: string;
  authorId?: string;
  authorName?: string;
  content?: string;
  timestamp?: Date;
  attachments?: string[];
  reactions?: string[];
}

export interface IIntegration extends Document {
  installationId?: string;
  podId: Types.ObjectId;
  type: IntegrationType;
  status: IntegrationStatus;
  config: {
    serverId?: string;
    serverName?: string;
    channelId?: string;
    channelName?: string;
    channelUrl?: string;
    webhookUrl?: string;
    botToken?: string;
    signingSecret?: string;
    secretToken?: string;
    botId?: string;
    groupId?: string;
    groupName?: string;
    groupUrl?: string;
    chatId?: string;
    chatTitle?: string;
    chatType?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    tokenExpiresAt?: Date;
    oauthScopes?: string[];
    username?: string;
    userId?: string;
    followUsernames?: string[];
    followUserIds?: string[];
    followFromAuthenticatedUser?: boolean;
    followingWhitelistUserIds?: string[];
    followingMaxUsers?: number;
    igUserId?: string;
    category?: string;
    apiBase?: string;
    maxResults?: number;
    exclude?: string;
    lastExternalId?: string;
    lastExternalTimestamp?: Date;
    connectCode?: string;
    permissions?: string[];
    webhookListenerEnabled?: boolean;
    lastSummaryAt?: Date;
    messageBuffer?: IIntegrationMessageBuffer[];
    maxBufferSize?: number;
    agentAccessEnabled?: boolean;
    globalAgentAccess?: boolean;
  };
  ingestTokens: IIngestToken[];
  lastSync?: Date | null;
  createdBy: Types.ObjectId;
  errorMessage?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const IntegrationSchema = new Schema<IIntegration>(
  {
    installationId: { type: String, unique: true, sparse: true },
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    type: {
      type: String,
      required: true,
      enum: ['discord', 'telegram', 'slack', 'messenger', 'groupme', 'whatsapp', 'x', 'instagram'],
      default: 'discord',
    },
    status: {
      type: String,
      required: true,
      enum: ['connected', 'disconnected', 'error', 'pending'],
      default: 'pending',
    },
    config: {
      serverId: String,
      serverName: String,
      channelId: String,
      channelName: String,
      channelUrl: String,
      webhookUrl: String,
      botToken: String,
      signingSecret: String,
      secretToken: String,
      botId: String,
      groupId: String,
      groupName: String,
      groupUrl: String,
      chatId: String,
      chatTitle: String,
      chatType: String,
      accessToken: String,
      refreshToken: String,
      tokenType: String,
      tokenExpiresAt: Date,
      oauthScopes: [String],
      username: String,
      userId: String,
      followUsernames: [String],
      followUserIds: [String],
      followFromAuthenticatedUser: { type: Boolean, default: false },
      followingWhitelistUserIds: [String],
      followingMaxUsers: { type: Number, default: 5 },
      igUserId: String,
      category: String,
      apiBase: String,
      maxResults: Number,
      exclude: String,
      lastExternalId: String,
      lastExternalTimestamp: Date,
      connectCode: String,
      permissions: [String],
      webhookListenerEnabled: { type: Boolean, default: false },
      lastSummaryAt: Date,
      messageBuffer: [
        {
          messageId: String,
          authorId: String,
          authorName: String,
          content: String,
          timestamp: Date,
          attachments: [String],
          reactions: [String],
        },
      ],
      maxBufferSize: { type: Number, default: 1000 },
      agentAccessEnabled: { type: Boolean, default: false },
      globalAgentAccess: { type: Boolean, default: false },
    },
    ingestTokens: [
      {
        tokenHash: { type: String, required: true },
        label: { type: String, default: '' },
        createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: { type: Date },
      },
    ],
    lastSync: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    errorMessage: { type: String, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'integrations' },
);

IntegrationSchema.index({ podId: 1, type: 1 });
IntegrationSchema.index({ status: 1 });
IntegrationSchema.index({ createdBy: 1 });
IntegrationSchema.index({ installationId: 1 }, { unique: true, sparse: true });
IntegrationSchema.index({ 'ingestTokens.tokenHash': 1 });

IntegrationSchema.virtual('platformIntegration', {
  ref() {
    switch ((this as IIntegration).type) {
      case 'discord': return 'DiscordIntegration';
      case 'telegram': return 'TelegramIntegration';
      case 'slack': return 'SlackIntegration';
      case 'messenger': return 'MessengerIntegration';
      default: return null;
    }
  },
  localField: '_id',
  foreignField: 'integrationId',
  justOne: true,
});

IntegrationSchema.set('toJSON', { virtuals: true });
IntegrationSchema.set('toObject', { virtuals: true });

export default mongoose.model<IIntegration>('Integration', IntegrationSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
