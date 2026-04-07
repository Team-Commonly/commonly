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

export interface IFollowedThread {
  postId: Types.ObjectId;
  followedAt: Date;
}

export interface IUser extends Document {
  username: string;
  email: string;
  password: string;
  verified: boolean;
  profilePicture: string;
  role: UserRole;
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
  };
  avatarMetadata: {
    style?: AvatarStyle;
    personality?: AvatarPersonality;
    colorScheme?: AvatarColorScheme;
    generatedAt?: Date;
    prompt?: string;
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
  subscribedPods: Types.ObjectId[];
  followers: Types.ObjectId[];
  following: Types.ObjectId[];
  followedThreads: IFollowedThread[];
  activityFeed: {
    lastViewedAt: Date;
    readItemIds: string[];
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
  lastActive: Date;
  lastDigestSent?: Date;
  createdAt: Date;
  // Instance methods
  comparePassword(password: string): Promise<boolean>;
  generateApiToken(): string;
  revokeApiToken(): void;
}

export interface IUserModel extends Model<IUser> {}

const userSchema = new Schema<IUser>({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  verified: { type: Boolean, default: false },
  profilePicture: { type: String, default: 'default' },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  apiToken: { type: String, unique: true, sparse: true },
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
  digestPreferences: {
    enabled: { type: Boolean, default: true },
    frequency: { type: String, enum: ['daily', 'weekly', 'never'], default: 'daily' },
    deliveryTime: { type: String, default: '06:00' },
    includeQuotes: { type: Boolean, default: true },
    includeInsights: { type: Boolean, default: true },
    includeTimeline: { type: Boolean, default: true },
    minActivityLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
  },
  lastActive: { type: Date, default: Date.now },
  lastDigestSent: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

userSchema.pre<IUser>('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function (password: string): Promise<boolean> {
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

export default mongoose.model<IUser, IUserModel>('User', userSchema);
