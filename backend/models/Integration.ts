import mongoose, { Document, Schema, Types } from 'mongoose';
import { toPublicIntegration } from './integrationPublicConfig';

export type IntegrationType =
  | 'discord'
  | 'telegram'
  | 'slack'
  | 'messenger'
  | 'groupme'
  | 'whatsapp'
  | 'x'
  | 'instagram'
  | 'github-app'
  // The runtime `enum` on the schema below is a string array mongoose does not
  // tie to this union, so the two can drift — and in the first cut of
  // TASK-172's slice 1 they did: the value was in the enum and not here, which
  // is how a typed write to a hosted row comes to need a cast (Vera, #1976
  // gate). The validator below is the arm that fails the day they drift again.
  | 'hosted-mcp';

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
    /** GitHub App installation connection (server-owned, no credential). */
    installationId?: string;
    owner?: string;
    repo?: string;
    serverId?: string;
    serverName?: string;
    channelId?: string;
    channelName?: string;
    channelUrl?: string;
    webhookUrl?: string;
    // The pointer to the encrypted copy, written by the Discord writers. `webhookUrl`
    // beside it is the legacy plaintext the migration unsets.
    webhookUrlRef?: string;
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
    /** Durable card receipts; unlike relayMap these are never evicted by count. */
    cards?: {
      podMessageId: string;
      tgMessageId?: string;
      externalMessageId?: string;
      sentAt: Date;
      closedAt?: Date;
    }[];
    // The hosted-MCP connection's own keys (TASK-172, scope §2), declared here
    // as well as in the schema below. The schema half closes the silent drop;
    // this half is what stops a typed write from needing a cast to state the
    // same thing — a cast being the same silence one layer up (Vera, #1976 gate).
    entryId?: string;
    intake?: 'oauth';
    providerSubject?: string;
    grantedScope?: string;
    expiresAt?: Date;
    credentialRef?: string;
    refreshTokenRef?: string;
    refreshGeneration?: number;
    credentialHint?: string;
    pendingAuth?: { state?: string; codeVerifier?: string; expiresAt?: Date };
  };
  ingestTokens: IIngestToken[];
  lastSync?: Date | null;
  createdBy: Types.ObjectId;
  errorMessage?: string | null;
  /**
   * True when `errorMessage` was written by Commonly for the person reading the
   * Connectors page, rather than copied out of a provider response. The page
   * renders the message only when this is set, so the two writers of this field
   * — our own classifier, and externalFeedService copying a provider's error
   * text or a raw `err.message` — cannot be told apart by the reader's eye alone.
   */
  errorMessageUserFacing?: boolean;
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
      enum: [
        'discord', 'telegram', 'slack', 'messenger', 'groupme', 'whatsapp',
        'x', 'instagram', 'github-app', 'hosted-mcp',
      ],
      default: 'discord',
    },
    status: {
      type: String,
      required: true,
      enum: ['connected', 'disconnected', 'error', 'pending'],
      default: 'pending',
    },
    config: {
      installationId: String,
      owner: String,
      repo: String,
      serverId: String,
      serverName: String,
      channelId: String,
      channelName: String,
      channelUrl: String,
      webhookUrl: String,
      // The pointer to the encrypted webhook URL (the connector-secret envelope).
      // Declared, not forgotten: `config` is a STRICT subdocument, so a `$set` of
      // an undeclared path here is dropped in silence — the row would keep no ref
      // at all and every reader would fall through to a plaintext field that the
      // migration had already unset (TASK-124 part 2).
      webhookUrlRef: String,
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
      // `hosted-mcp` — a per-person Connection to a vendor-hosted remote MCP
      // server (TASK-172, docs/plans/hosted-mcp-connection-scope.md §2).
      // Every key is declared because `config` is a STRICT subdocument: an
      // undeclared `$set` is dropped in silence (see webhookUrlRef above), and
      // here the silence would be a credential reference that the row never
      // kept — the OAuth callback reporting a connect that holds no token.
      // Only that callback writes any of them; all of them are server-owned
      // (utils/serverOwnedConfigKeys) and the three that name a secret or a
      // nonce are withheld from every serialization
      // (models/integrationPublicConfig).

      // Which catalogue entry the row connects; fixed at the first connect.
      // Required CONDITIONALLY, like `podId` one level up, because the index
      // below is unique on `(createdBy, config.entryId)` and a hosted-mcp row
      // with no entry is indexed as `null`: two of them for one person collided
      // with an E11000 naming `config.entryId`, a refusal that reports a
      // duplicate entry to a writer whose two rows share no entry at all
      // (Vera, #1976 gate, measured). Refused here, the failure names the
      // missing field instead. `trim` for the same invariant: `'linear '` and
      // `'linear'` are one entry, not two.
      entryId: {
        type: String,
        trim: true,
        required(this: IIntegration) {
          return this.type === 'hosted-mcp';
        },
      },
      intake: String, // 'oauth' is the only intake for this type
      providerSubject: String, // the authorization server's stable id for the account
      grantedScope: String, // the token response's `scope`: what the person consented to
      expiresAt: Date, // the access token's expiry, when the AS states one
      credentialRef: String, // ConnectorSecret ref: the access token
      refreshTokenRef: String, // ConnectorSecret ref: the refresh token
      refreshGeneration: Number, // the §10.3 fence's generation at the last refresh
      credentialHint: String,
      // Present only mid-connect, and holding nothing secret once it expires.
      pendingAuth: {
        state: String,
        codeVerifier: String,
        expiresAt: Date,
        // The browser-bound half of the flow (§10.7): `state` proves the flow
        // exists, this proves the browser finishing it is the one that started
        // it. Declared here because this subdocument is STRICT — an undeclared
        // path is dropped in silence, and the check would then read as armed
        // while comparing `undefined` against a real cookie.
        browserNonce: String,
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
      cards: [{
        _id: false,
        podMessageId: { type: String, required: true },
        tgMessageId: String,
        externalMessageId: String,
        sentAt: { type: Date, required: true },
        closedAt: Date,
      }],
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
    // Set by connectorDeliveryFailureService, the only writer that puts text on
    // the Connectors page for a person to read (see the model interface).
    errorMessageUserFacing: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'integrations' },
);

IntegrationSchema.index({ podId: 1, type: 1 });
IntegrationSchema.index({ status: 1 });
IntegrationSchema.index({ createdBy: 1 });
IntegrationSchema.index({ installationId: 1 }, { unique: true, sparse: true });
// One `hosted-mcp` row per (person, catalogue entry). The page cannot say which
// row a grant uses if a person holds two for one vendor, and the two would go
// through removal separately (scope §2). Partial, not sparse: `config.entryId`
// is absent on every other type, and every other type has no such key to
// collide on. A second connect by the same person REUSES the row through the
// §10.3 fence rather than inserting one.
IntegrationSchema.index(
  { createdBy: 1, 'config.entryId': 1 },
  { unique: true, partialFilterExpression: { type: 'hosted-mcp' } },
);
IntegrationSchema.index({ 'ingestTokens.tokenHash': 1 });
// Installable Slack Events API lookup: a global endpoint resolves a bound DM
// solely by its workspace and channel, then still checks isActive.
IntegrationSchema.index({ type: 1, 'config.teamId': 1, 'config.chatId': 1, isActive: 1 });

// Only Discord keeps platform state in a collection of its own; every other
// connector carries it in `config`. A ref naming a model nothing registers is
// not a no-op: Mongoose throws MissingSchemaError at populate time, and one
// Telegram row took the admin list down with it (#1672). Null skips the join.
IntegrationSchema.virtual('platformIntegration', {
  ref() {
    return (this as IIntegration).type === 'discord' ? 'DiscordIntegration' : null;
  },
  localField: '_id',
  foreignField: 'integrationId',
  justOne: true,
});

// Bearer credentials and the references that point at one (claim ids, ingest
// token hashes) are server-only in every normal JSON response, including the
// pending OAuth bind that needs to show its workspace/user details. The list
// lives in integrationPublicConfig so the lean catalog read strips the same
// fields.
IntegrationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc: unknown, returned: Record<string, unknown>) => {
    toPublicIntegration(returned);
    return returned;
  },
});
IntegrationSchema.set('toObject', { virtuals: true });

export default mongoose.model<IIntegration>('Integration', IntegrationSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
