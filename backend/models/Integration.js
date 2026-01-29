const mongoose = require('mongoose');

const IntegrationSchema = new mongoose.Schema(
  {
    installationId: {
      type: String,
      unique: true,
      sparse: true, // Allow null/undefined for non-Discord integrations
    },
    podId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['discord', 'telegram', 'slack', 'messenger', 'groupme', 'whatsapp'],
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
      connectCode: String,
      permissions: [String],
      webhookListenerEnabled: {
        type: Boolean,
        default: false,
      },
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
      maxBufferSize: {
        type: Number,
        default: 1000,
      },
    },
    ingestTokens: [
      {
        tokenHash: { type: String, required: true },
        label: { type: String, default: '' },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: { type: Date },
      },
    ],
    lastSync: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    collection: 'integrations',
  },
);

// Index for efficient queries
IntegrationSchema.index({ podId: 1, type: 1 });
IntegrationSchema.index({ status: 1 });
IntegrationSchema.index({ createdBy: 1 });
IntegrationSchema.index({ installationId: 1 }, { unique: true, sparse: true });
IntegrationSchema.index({ 'ingestTokens.tokenHash': 1 });

// Virtual for platform-specific integration
IntegrationSchema.virtual('platformIntegration', {
  ref() {
    switch (this.type) {
      case 'discord':
        return 'DiscordIntegration';
      case 'telegram':
        return 'TelegramIntegration';
      case 'slack':
        return 'SlackIntegration';
      case 'messenger':
        return 'MessengerIntegration';
      default:
        return null;
    }
  },
  localField: '_id',
  foreignField: 'integrationId',
  justOne: true,
});

// Ensure virtuals are serialized
IntegrationSchema.set('toJSON', { virtuals: true });
IntegrationSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Integration', IntegrationSchema);
