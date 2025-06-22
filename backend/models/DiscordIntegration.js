const mongoose = require('mongoose');

const DiscordIntegrationSchema = new mongoose.Schema({
  integrationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Integration',
    required: true,
  },
  serverId: {
    type: String,
    required: true,
  },
  serverName: {
    type: String,
    required: true,
  },
  channelId: {
    type: String,
    required: true,
  },
  channelName: {
    type: String,
    required: true,
  },
  webhookUrl: {
    type: String,
    required: true,
  },
  webhookId: {
    type: String,
    required: true,
  },
  botToken: {
    type: String,
    required: true,
    // Note: This should be encrypted in production
  },
  permissions: [{
    type: String,
    enum: ['read_messages', 'send_messages', 'read_message_history', 'manage_webhooks'],
  }],
  messageHistory: [{
    messageId: String,
    content: String,
    author: String,
    timestamp: Date,
    attachments: [String],
  }],
  lastMessageId: {
    type: String,
    default: null,
  },
  messageCount: {
    type: Number,
    default: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
  collection: 'discord_integrations',
});

// Indexes for efficient queries
DiscordIntegrationSchema.index({ integrationId: 1 }, { unique: true });
DiscordIntegrationSchema.index({ serverId: 1, channelId: 1 });
DiscordIntegrationSchema.index({ webhookId: 1 });

// Ensure webhook URL is valid Discord webhook format
DiscordIntegrationSchema.pre('save', function (next) {
  if (this.webhookUrl && !this.webhookUrl.includes('discord.com/api/webhooks/')) {
    return next(new Error('Invalid Discord webhook URL format'));
  }
  next();
});

// Virtual for getting recent messages
DiscordIntegrationSchema.virtual('recentMessages', {
  get() {
    return this.messageHistory
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 50); // Last 50 messages
  },
});

// Ensure virtuals are serialized
DiscordIntegrationSchema.set('toJSON', { virtuals: true });
DiscordIntegrationSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('DiscordIntegration', DiscordIntegrationSchema);
