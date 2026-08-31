import mongoose, { Document, Schema, Types, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export type UserRole = 'user' | 'admin';
export type BotType = 'system' | 'agent' | 'bridge' | null;
export type AvatarStyle = 'banana' | 'abstract' | 'minimalist' | 'cartoon' | 'geometric' | 'custom';
export type AvatarPersonality = 'friendly' | 'professional' | 'playful' | 'wise' | 'creative';
export type AvatarColorScheme = 'vibrant' | 'pastel' | 'monochrome' | 'neon';
export type AgentTone = 'friendly' | 'professional' | 'sarcastic' | 'educational' | 'humorous';
export type AgentBehavior = 'reactive' | 'proactive' | 'balanced';
export type AgentResponseStyle = 'concise' | 'detailed' | 'conversational';
export type AgentCapability = 'chat' | 'summarize' | 'curate' | 'moderate' | 'translate';
export type DigestFrequency = 'daily' | 'weekly' | 'never';
export type ActivityLevel = 'low' | 'medium' | 'high';

export interface IAgentRuntimeToken {
  tokenHash: string;
  label?: string;
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
}

// A device-login bearer is intentionally one-way: the CLI receives it once,
// while Mongo stores only this digest. It is long-lived until explicit
// revocation (there is no expiresAt or transparent refresh) and is separate
// from the legacy apiToken (which pre-dates per-device revocation) and agent
// runtime tokens.
export interface IDeviceToken {
  tokenHash: string;
  label: string;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface IFollowedThread {
  postId: Types.ObjectId;
  followedAt: Date;
}

// Social-login identities linked to this account. A user may have zero
// (password-only), one, or several (GitHub + Google linked by verified
// email). Accounts created via OAuth have no password — see the
// conditional `required` on the password path below.
export type AuthProviderName = 'github' | 'google';

export interface IAuthProvider {
  provider: AuthProviderName;
  providerId: string;
  email?: string;
  linkedAt: Date;
}

// User-level alias → agent (or human) binding. Both human and bot users
// carry this list; for bots it's the agent's "contacts" — who they go to
// for codex review, planning, etc. For humans it's the people they DM
// most. Aliases must be lowercase URL-safe.
export type ContactSource = 'user' | 'pod' | 'system';

export interface IContactEntry {
  alias: string;
  agentName?: string;
  instanceId?: string;
  targetUserId?: Types.ObjectId;
  role?: string;
  source: ContactSource;
  pinned?: boolean;
  addedAt: Date;
}

export interface IUser extends Document {
  username: string;
  email: string;
  password?: string;
  authProviders: IAuthProvider[];
  verified: boolean;
  // Admin moderation (GH: admin user management). banned users cannot log in
  // and existing sessions are refused by the auth middleware on next request.
  banned: boolean;
  bannedAt?: Date;
  banReason?: string;
  profilePicture: string;
  role: UserRole;
  // Capability gate for hosted (cloud) agents. Defaults to false so opening
  // registration doesn't hand every new signup free Commonly-managed compute.
  // Admins are implicitly allowed (the gate checks role === 'admin' OR this
  // flag). BYO / self-hosted agents are never gated by this field — see
  // agentIdentityService.isCloudRuntime + routes/registry/{install,provision}.
  entitlements: {
    cloudAgents: boolean;
    // Paid tier. Gates capabilities that cost us money or expose the instance
    // to the public — today: listing a pod to Community, and unlimited message
    // history (free accounts keep the 30-day pgRetentionService window).
    // BYO agents are NEVER gated by this: "agents you bring connect free and
    // unlimited" is the product's standing promise, and a per-agent cap is the
    // thing this pricing model exists to avoid.
    // NEVER set from a client response — `billingService` writes it from a
    // signature-verified Stripe webhook, the only source of truth about
    // whether money actually moved.
    pro: boolean;
  };
  // Stripe linkage. `customerId` is the join key from webhook -> user; it is
  // set at checkout creation so an event can always be resolved even if the
  // session metadata is missing. `subscriptionStatus` mirrors Stripe rather
  // than being derived, so support can see WHY someone lost access.
  billing?: {
    customerId?: string;
    subscriptionId?: string;
    subscriptionStatus?: string;
    currentPeriodEnd?: Date;
    cancelAtPeriodEnd?: boolean;
    // When Pro last ended. Features stop at once; the retention cron keeps
    // this account's history for PRO_DATA_GRACE_DAYS past this instant, so a
    // failed card payment does not destroy history overnight.
    proEndedAt?: Date;
  };
  apiToken?: string;
  apiTokenCreatedAt?: Date;
  apiTokenScopes: string[];
  isBot: boolean;
  botType: BotType;
  botMetadata: {
    displayName?: string;
    description?: string;
    runtimeId?: string;
    officialAgent?: boolean;
    capabilities?: string[];
    agentName?: string;
    instanceId?: string;
    // ADR-026 D3: the machine this identity is bound to (adoption CAS).
    machineId?: string | null;
    runtime?: string;
    icon?: string;
  };
  avatarMetadata: {
    style?: AvatarStyle;
    personality?: AvatarPersonality;
    colorScheme?: AvatarColorScheme;
    generatedAt?: Date;
    prompt?: string;
    source?: 'openai' | 'gemini' | 'svg' | 'manual';
    model?: string;
  };
  agentConfig: {
    personality: {
      tone: AgentTone;
      interests: string[];
      behavior: AgentBehavior;
      responseStyle: AgentResponseStyle;
    };
    systemPrompt: string;
    capabilities: AgentCapability[];
  };
  agentRuntimeTokens: IAgentRuntimeToken[];
  deviceTokens: IDeviceToken[];
  contacts: IContactEntry[];
  subscribedPods: Types.ObjectId[];
  followers: Types.ObjectId[];
  following: Types.ObjectId[];
  followedThreads: IFollowedThread[];
  activityFeed: {
    lastViewedAt: Date;
    readItemIds: string[];
  };
  // Queue acknowledgement is deliberately separate from activityFeed read
  // state. Opening a feed is not the same as resolving a direct mention.
  activityQueue: {
    acknowledgedMentionIds: string[];
  };
  digestPreferences: {
    enabled: boolean;
    frequency: DigestFrequency;
    deliveryTime: string;
    includeQuotes: boolean;
    includeInsights: boolean;
    includeTimeline: boolean;
    minActivityLevel: ActivityLevel;
  };
  emailPreferences: {
    dailyDigest: boolean;
  };
  digestUnsubscribeToken?: string;
  lastActive: Date;
  lastDigestSent?: Date;
  createdAt: Date;
  // Instance methods
  comparePassword(password: string): Promise<boolean>;
  generateApiToken(): string;
  revokeApiToken(): void;
  getOrCreateDigestUnsubscribeToken(): string;
}

export interface IUserModel extends Model<IUser> {}

const userSchema = new Schema<IUser>({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  // Password is only required for accounts with no linked OAuth identity —
  // OAuth-created accounts authenticate via provider and have no password.
  password: {
    type: String,
    required: function (this: IUser) {
      return !(Array.isArray(this.authProviders) && this.authProviders.length > 0);
    },
  },
  authProviders: {
    type: [
      new Schema<IAuthProvider>({
        provider: { type: String, enum: ['github', 'google'], required: true },
        providerId: { type: String, required: true },
        email: { type: String },
        linkedAt: { type: Date, default: Date.now },
      }, { _id: false }),
    ],
    default: [],
  },
  verified: { type: Boolean, default: false },
  banned: { type: Boolean, default: false },
  bannedAt: { type: Date },
  banReason: { type: String },
  profilePicture: { type: String, default: 'default' },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  // Hosted-agent entitlement gate (see IUser.entitlements). Default false;
  // admins bypass it. Nested object so future entitlements slot in here.
  entitlements: {
    cloudAgents: { type: Boolean, default: false },
    pro: { type: Boolean, default: false },
  },
  billing: {
    // Indexed: every webhook resolves a user by this in the hot path.
    customerId: { type: String, index: true, sparse: true },
    subscriptionId: { type: String },
    subscriptionStatus: { type: String },
    currentPeriodEnd: { type: Date },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    // Indexed: the nightly retention run queries lapsed-but-in-grace accounts.
    proEndedAt: { type: Date, index: true, sparse: true },
  },
  // `select: false` so a live bearer credential can never ride along on an
  // incidental `findById().select('-password')` or a populate(). Queries that
  // FILTER on this field still work (projection is separate from the filter),
  // so token authentication in middleware/auth.ts is unaffected. Any code that
  // needs to READ the value back must ask for it explicitly with
  // `.select('+apiToken')` — see agentIdentityService.getOrCreateAgentUser,
  // where failing to do so would make an existing agent token look absent and
  // silently rotate it out from under every running wrapper.
  apiToken: {
    type: String, unique: true, sparse: true, select: false,
  },
  apiTokenCreatedAt: { type: Date },
  apiTokenScopes: [{ type: String }],
  isBot: { type: Boolean, default: false },
  botType: {
    type: String,
    enum: ['system', 'agent', 'bridge', null],
    default: null,
  },
  botMetadata: {
    displayName: { type: String },
    description: { type: String },
    runtimeId: { type: String },
    officialAgent: { type: Boolean, default: false },
    capabilities: [{ type: String }],
    agentName: { type: String },
    instanceId: { type: String },
    // ADR-026 D3 — declared or Mongoose strips it (the #1282 lesson).
    machineId: { type: String, default: null },
  },
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
    prompt: { type: String },
    source: {
      type: String,
      enum: ['openai', 'gemini', 'svg', 'manual'],
    },
    model: { type: String },
  },
  agentConfig: {
    personality: {
      tone: {
        type: String,
        enum: ['friendly', 'professional', 'sarcastic', 'educational', 'humorous'],
        default: 'friendly',
      },
      interests: [{ type: String, trim: true }],
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
  agentRuntimeTokens: [
    {
      tokenHash: { type: String, required: true },
      label: { type: String },
      createdAt: { type: Date, default: Date.now },
      lastUsedAt: { type: Date },
      expiresAt: { type: Date },
    },
  ],
  // D1 device-code login. Do not mark this select:false: auth middleware must
  // inspect the digest, and response serializers explicitly omit the whole
  // array so these records never become an account-profile API surface.
  deviceTokens: {
    type: [
      new Schema<IDeviceToken>({
        tokenHash: { type: String, required: true },
        label: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: { type: Date },
        revokedAt: { type: Date },
      }, { _id: true }),
    ],
    default: [],
  },
  // Alias-driven contact list — see IContactEntry above. Default empty so
  // existing user rows return `[]` on read (never throws on `.find(...)`).
  contacts: {
    type: [
      new Schema<IContactEntry>({
        alias: { type: String, required: true, lowercase: true, trim: true },
        agentName: { type: String, default: null },
        instanceId: { type: String, default: null },
        targetUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        role: { type: String, default: null },
        source: { type: String, enum: ['user', 'pod', 'system'], default: 'user' },
        pinned: { type: Boolean, default: false },
        addedAt: { type: Date, default: Date.now },
      }, { _id: false }),
    ],
    default: [],
  },
  subscribedPods: [{ type: Schema.Types.ObjectId, ref: 'Pod' }],
  followers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  followedThreads: [
    {
      postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
      followedAt: { type: Date, default: Date.now },
    },
  ],
  activityFeed: {
    lastViewedAt: { type: Date, default: new Date(0) },
    readItemIds: { type: [String], default: [] },
  },
  activityQueue: {
    acknowledgedMentionIds: { type: [String], default: [] },
  },
  digestPreferences: {
    enabled: { type: Boolean, default: true },
    frequency: { type: String, enum: ['daily', 'weekly', 'never'], default: 'daily' },
    deliveryTime: { type: String, default: '06:00' },
    includeQuotes: { type: Boolean, default: true },
    includeInsights: { type: Boolean, default: true },
    includeTimeline: { type: Boolean, default: true },
    minActivityLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
  },
  emailPreferences: {
    dailyDigest: { type: Boolean, default: true },
  },
  // Capability token: it can only disable digest mail. Hidden from normal
  // User projections and generated lazily when the first email is sent.
  digestUnsubscribeToken: { type: String, select: false },
  lastActive: { type: Date, default: Date.now },
  lastDigestSent: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

// OAuth callback looks users up by (provider, providerId) on every social login.
userSchema.index({ 'authProviders.provider': 1, 'authProviders.providerId': 1 });
// A single index supports authentication by digest and the account's device
// list. Existing users simply have no array entries, so this is additive.
userSchema.index({ 'deviceTokens.tokenHash': 1 });
userSchema.index(
  { digestUnsubscribeToken: 1 },
  {
    unique: true,
    partialFilterExpression: { digestUnsubscribeToken: { $type: 'string' } },
  },
);

userSchema.pre<IUser>('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function (password: string): Promise<boolean> {
  if (!this.password) return false; // OAuth-only account — no password to compare
  return bcrypt.compare(password, this.password);
};

userSchema.methods.generateApiToken = function (): string {
  this.apiToken = `cm_${crypto.randomBytes(32).toString('hex')}`;
  this.apiTokenCreatedAt = new Date();
  return this.apiToken;
};

userSchema.methods.revokeApiToken = function (): void {
  this.apiToken = undefined;
  this.apiTokenCreatedAt = undefined;
};

userSchema.methods.getOrCreateDigestUnsubscribeToken = function (): string {
  if (!this.digestUnsubscribeToken) {
    this.digestUnsubscribeToken = crypto.randomBytes(24).toString('hex');
  }
  return this.digestUnsubscribeToken;
};

export default mongoose.model<IUser, IUserModel>('User', userSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
