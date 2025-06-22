const discordConfig = {
  // Bot configuration
  clientId: process.env.DISCORD_CLIENT_ID,
  botToken: process.env.DISCORD_BOT_TOKEN,

  // Permission configuration
  requiredPermissions: [
    'VIEW_CHANNEL',
    'SEND_MESSAGES',
    'READ_MESSAGE_HISTORY',
    'MANAGE_WEBHOOKS',
  ],

  // Webhook configuration
  webhookName: 'Commonly Integration',
  webhookAvatar: 'https://your-domain.com/commonly-logo.png', // Replace with actual logo URL

  // Rate limiting
  messageRateLimit: {
    maxMessages: 5,
    timeWindow: 5000, // 5 seconds
  },

  // Error messages
  errors: {
    BOT_NOT_IN_SERVER: 'Bot is not present in the Discord server',
    MISSING_PERMISSIONS: 'Bot lacks required permissions in the channel',
    CHANNEL_NOT_FOUND: 'Discord channel not found',
    SERVER_NOT_FOUND: 'Discord server not found',
    RATE_LIMITED: 'Too many messages sent. Please wait a moment.',
  },
};

module.exports = discordConfig;
