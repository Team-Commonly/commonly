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
export type IntegrationScope = 'pod' | 'user';

export interface IIntegrationGate {
  enabled: boolean;
  mode?: 'attention' | 'mirror';
  lead?: string;
  since: Date;
}

/** Server-owned projection of an administrator's parent-level pause. */
export interface IIntegrationAdminPause {
  reason: string;
  at: Date;
  adminId: string;
}

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
  /** InstallableInstallation claim generation that minted this projection's code. */
  installationClaimId?: string;
  /** Terminal tombstone: a revoked projection can never be activated again. */
  revokedAt?: Date;
  /**
   * Legacy pod-scoped rows require a pod. User-scoped connector rows retain
   * their currently selected pod here for bare-message routing, but their
   * outbound subscriptions live in config.gates.
   */
  podId?: Types.ObjectId;
  scope: IntegrationScope;
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
    connectCodeExpiresAt?: Date | null;
    /** Slack OAuth callback nonce — random, short-lived, and never exposed. */
    oauthStateNonce?: string;
    oauthStateNonceExpiresAt?: Date;
    oauthStateClaimId?: string;
    permissions?: string[];
    webhookListenerEnabled?: boolean;
    lastSummaryAt?: Date;
    messageBuffer?: IIntegrationMessageBuffer[];
    maxBufferSize?: number;
    agentAccessEnabled?: boolean;
    globalAgentAccess?: boolean;
    // Telegram live bridge (telegramBridgeService). Undeclared config paths
    // are silently stripped by Mongoose writes — these MUST stay declared or
    // the enable path becomes a no-op that reports success (found by
    // sprint-review on #1282 before first deploy).
    liveRelay?: boolean;
    linkedUserId?: string;
    leadAgentUsername?: string;
    relayAllAgentMessages?: boolean;
    relayMutedUntil?: Date;
    gates?: Record<string, IIntegrationGate>;
    adminPause?: IIntegrationAdminPause;
    /** Opaque ConnectorSecret id; credentials never live on the Integration. */
    botTokenRef?: string;
    /** Slack's workspace identity and the bound one-to-one DM. */
    teamId?: string;
    teamName?: string;
    slackUserId?: string;
    slackUserName?: string;
    pendingBind?: {
      teamId: string;
      teamName?: string;
      slackUserId: string;
      slackUserName?: string;
      chatId: string;
      botTokenRef: string;
      expiresAt: Date;
    };
    relayMap?: {
      /** Generic D11 reply key. Telegram retains tgMessageId during migration. */
      externalMessageId?: string;
      tgMessageId?: string;
      agentUsername: string;
      podMessageId?: string | null;
      podId?: string;
    }[];
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
    installationClaimId: { type: String },
    revokedAt: { type: Date },
    podId: {
      type: Schema.Types.ObjectId,
      ref: 'Pod',
      required(this: IIntegration) {
        return this.scope === 'pod';
      },
    },
    scope: {
      type: String,
      enum: ['pod', 'user'],
      default: 'pod',
      required: true,
    },
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
      connectCodeExpiresAt: Date,
      oauthStateNonce: String,
      oauthStateNonceExpiresAt: Date,
      oauthStateClaimId: String,
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
      // Telegram live bridge — see interface note above; keep in lockstep.
      liveRelay: { type: Boolean, default: false },
      linkedUserId: String,
      leadAgentUsername: String,
      relayAllAgentMessages: { type: Boolean, default: false },
      relayMutedUntil: Date,
      gates: {
        type: Map,
        of: new Schema<IIntegrationGate>({
          enabled: { type: Boolean, required: true },
          mode: { type: String, enum: ['attention', 'mirror'] },
          lead: String,
          since: { type: Date, required: true },
        }, { _id: false }),
      },
      adminPause: {
        type: new Schema<IIntegrationAdminPause>({
          reason: { type: String, required: true },
          at: { type: Date, required: true },
          adminId: { type: String, required: true },
        }, { _id: false }),
        default: undefined,
      },
      // Connector secrets live in ConnectorSecret; routes must never accept
      // this reference from clients (see SERVER_OWNED_CONFIG_KEYS).
      botTokenRef: String,
      teamId: String,
      teamName: String,
      slackUserId: String,
      slackUserName: String,
      pendingBind: {
        teamId: String,
        teamName: String,
        slackUserId: String,
        slackUserName: String,
        chatId: String,
        botTokenRef: String,
        expiresAt: Date,
      },
      relayMap: [
        {
          externalMessageId: String,
          tgMessageId: String,
          agentUsername: String,
          podMessageId: String,
          podId: String,
        },
      ],
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
// Installable Slack Events API lookup: a global endpoint resolves a bound DM
// solely by its workspace and channel, then still checks isActive.
IntegrationSchema.index({ type: 1, 'config.teamId': 1, 'config.chatId': 1, isActive: 1 });

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

// A ConnectorSecret reference is itself not a bearer credential, but returning
// it still widens the set of clients that can reason about server-side secret
// storage. Keep it server-only in every normal JSON response, including the
// pending OAuth bind that needs to show its workspace/user details.
IntegrationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc: unknown, returned: { config?: Record<string, unknown> }) => {
    if (!returned.config) return returned;
    delete returned.config.botTokenRef;
    delete returned.config.oauthStateNonce;
    const pending = returned.config.pendingBind;
    if (pending && typeof pending === 'object') {
      delete (pending as Record<string, unknown>).botTokenRef;
    }
    return returned;
  },
});
IntegrationSchema.set('toObject', { virtuals: true });

export default mongoose.model<IIntegration>('Integration', IntegrationSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
