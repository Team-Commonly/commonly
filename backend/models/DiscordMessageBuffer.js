const mongoose = require('mongoose');

const DiscordMessageBufferSchema = new mongoose.Schema({
  integrationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Integration',
    required: true,
  },
  messageId: {
    type: String,
    required: true,
  },
  authorId: {
    type: String,
    required: true,
  },
  authorName: {
    type: String,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    required: true,
  },
  attachments: [{
    type: String,
  }],
  reactions: [{
    type: String,
  }],
  createdAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
  collection: 'discord_message_buffer',
});

// Indexes for efficient queries
DiscordMessageBufferSchema.index({ integrationId: 1, timestamp: -1 });
DiscordMessageBufferSchema.index({ messageId: 1 }, { unique: true });
DiscordMessageBufferSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 }); // Auto-delete after 24 hours

module.exports = mongoose.model('DiscordMessageBuffer', DiscordMessageBufferSchema);
