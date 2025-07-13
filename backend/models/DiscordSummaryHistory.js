const mongoose = require('mongoose');

const DiscordSummaryHistorySchema = new mongoose.Schema({
  integrationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Integration',
    required: true,
  },
  summaryType: {
    type: String,
    required: true,
    enum: ['hourly', 'daily', 'manual'],
  },
  content: {
    type: String,
    required: true,
  },
  messageCount: {
    type: Number,
    required: true,
  },
  timeRange: {
    start: {
      type: Date,
      required: true,
    },
    end: {
      type: Date,
      required: true,
    },
  },
  postedToDiscord: {
    type: Boolean,
    default: false,
  },
  postedToCommonly: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
  collection: 'discord_summary_history',
});

// Indexes for efficient queries
DiscordSummaryHistorySchema.index({ integrationId: 1, createdAt: -1 });
DiscordSummaryHistorySchema.index({ summaryType: 1 });
DiscordSummaryHistorySchema.index({ timeRange: 1 });

module.exports = mongoose.model('DiscordSummaryHistory', DiscordSummaryHistorySchema);
