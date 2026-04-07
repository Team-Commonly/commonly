// eslint-disable-next-line global-require
const { PermissionFlagsBits } = require('discord.js');

interface DiscordConfig {
  clientId: string | undefined;
  applicationId: string | undefined;
  botToken: string | undefined;
  requiredPermissions: unknown[];
  webhookName: string;
  webhookAvatar: string;
  messageRateLimit: { maxMessages: number; timeWindow: number };
  errors: {
    BOT_NOT_IN_SERVER: string;
    MISSING_PERMISSIONS: string;
    CHANNEL_NOT_FOUND: string;
    SERVER_NOT_FOUND: string;
    RATE_LIMITED: string;
  };
}

const discordConfig: DiscordConfig = {
  clientId: process.env.DISCORD_CLIENT_ID,
  applicationId: process.env.DISCORD_APPLICATION_ID || process.env.DISCORD_CLIENT_ID,
  botToken: process.env.DISCORD_BOT_TOKEN,

  requiredPermissions: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageWebhooks,
  ],

  webhookName: 'Commonly Integration',
  webhookAvatar: 'https://your-domain.com/commonly-logo.png',

  messageRateLimit: {
    maxMessages: 5,
    timeWindow: 5000,
  },

  errors: {
    BOT_NOT_IN_SERVER: 'Bot is not present in the Discord server',
    MISSING_PERMISSIONS: 'Bot lacks required permissions in the channel',
    CHANNEL_NOT_FOUND: 'Discord channel not found',
    SERVER_NOT_FOUND: 'Discord server not found',
    RATE_LIMITED: 'Too many messages sent. Please wait a moment.',
  },
};

module.exports = discordConfig;
