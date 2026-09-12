import mongoose, { Document, Schema, Types } from 'mongoose';

export type DiscordPermission =
  | 'read_messages'
  | 'send_messages'
  | 'read_message_history'
  | 'manage_webhooks';

export interface IDiscordMessageHistory {
  messageId?: string;
  content?: string;
  author?: string;
  timestamp?: Date;
  attachments?: string[];
}

export interface IDiscordIntegration extends Document {
  integrationId: Types.ObjectId;
  serverId: string;
  serverName: string;
  channelId: string;
  channelName: string;
  webhookUrl: string;
  webhookId: string;
  botToken: string;
  permissions: DiscordPermission[];
  messageHistory: IDiscordMessageHistory[];
  lastMessageId: string | null;
  messageCount: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DiscordIntegrationSchema = new Schema<IDiscordIntegration>(
  {
    integrationId: { type: Schema.Types.ObjectId, ref: 'Integration', required: true },
    serverId: { type: String, required: true },
    serverName: { type: String, required: true },
    channelId: { type: String, required: true },
    channelName: { type: String, required: true },
    webhookUrl: { type: String, required: true },
    webhookId: { type: String, required: true },
    botToken: { type: String, required: true },
    permissions: [
      {
        type: String,
        enum: ['read_messages', 'send_messages', 'read_message_history', 'manage_webhooks'],
      },
    ],
    messageHistory: [
      {
        messageId: String,
        content: String,
        author: String,
        timestamp: Date,
        attachments: [String],
      },
    ],
    lastMessageId: { type: String, default: null },
    messageCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'discord_integrations' },
);

DiscordIntegrationSchema.index({ integrationId: 1 }, { unique: true });
DiscordIntegrationSchema.index({ serverId: 1, channelId: 1 });
DiscordIntegrationSchema.index({ webhookId: 1 });

DiscordIntegrationSchema.pre<IDiscordIntegration>('save', function (next) {
  if (this.webhookUrl && !this.webhookUrl.includes('discord.com/api/webhooks/')) {
    return next(new Error('Invalid Discord webhook URL format'));
  }
  next();
});

DiscordIntegrationSchema.virtual('recentMessages').get(function (this: IDiscordIntegration) {
  return this.messageHistory
    .sort((a, b) => new Date(b.timestamp!).getTime() - new Date(a.timestamp!).getTime())
    .slice(0, 50);
});

// The record joins onto Integration as `platformIntegration` and rides out
// through every list that populates it (admin Apps list, pod list, create).
// botToken is the instance-wide DISCORD_BOT_TOKEN and webhookUrl carries the
// webhook's secret; both stay server-only in every JSON response. Server code
// reads them off the document, never off its JSON.
DiscordIntegrationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc: unknown, returned: Record<string, unknown>) => {
    delete returned.botToken;
    delete returned.webhookUrl;
    return returned;
  },
});
DiscordIntegrationSchema.set('toObject', { virtuals: true });

export default mongoose.model<IDiscordIntegration>('DiscordIntegration', DiscordIntegrationSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
