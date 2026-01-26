const User = require('../models/User');
const Pod = require('../models/Pod');
const socketConfig = require('../config/socket');

// Use PostgreSQL for messages if available, fallback to MongoDB
let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  console.warn(
    'PostgreSQL Message model not available, using MongoDB fallback',
  );
  PGMessage = null;
}

// Fallback MongoDB Message model
const Message = require('../models/Message');

// PostgreSQL connection
let dbPg;
try {
  // eslint-disable-next-line global-require
  dbPg = require('../config/db-pg');
} catch (error) {
  console.warn('PostgreSQL db config not available');
  dbPg = null;
}

/**
 * Commonly Bot Service
 * Manages the bot user and posts external integration summaries to pods
 */
class CommonlyBotService {
  constructor() {
    this.botUser = null;
    this.BOT_USERNAME = 'commonly-bot';
    this.BOT_EMAIL = 'bot@commonly.app';
  }

  /**
   * Get or create the Commonly Bot user
   */
  async getBotUser() {
    if (this.botUser) {
      return this.botUser;
    }

    // Try to find existing bot user
    this.botUser = await User.findOne({ username: this.BOT_USERNAME });

    if (!this.botUser) {
      // Create the bot user
      this.botUser = new User({
        username: this.BOT_USERNAME,
        email: this.BOT_EMAIL,
        password: `bot-password-${Date.now()}`, // Random password, won't be used for login
        verified: true,
        profilePicture: 'purple', // Cute purple avatar for the bot
        role: 'user',
      });

      await this.botUser.save();
      console.log('✨ Commonly Bot user created!');
    }

    return this.botUser;
  }

  /**
   * Post a Discord summary to a Commonly pod
   * @param {string} podId - The pod ID to post to
   * @param {object} discordSummary - The Discord summary data
   * @param {string} integrationId - The integration ID
   */
  async postDiscordSummaryToPod(podId, discordSummary, integrationId) {
    try {
      const bot = await this.getBotUser();

      // Check if pod exists
      const pod = await Pod.findById(podId);
      if (!pod) {
        throw new Error(`Pod ${podId} not found`);
      }

      // Ensure bot is a member of the pod
      if (!pod.members.includes(bot._id)) {
        pod.members.push(bot._id);
        await pod.save();
        console.log(`🤖 Added Commonly Bot to pod: ${pod.name}`);
      }

      // Format the Discord summary for the pod
      const messageContent = CommonlyBotService.formatDiscordSummaryForPod(discordSummary);

      let message;

      // Use PostgreSQL if available, otherwise fallback to MongoDB
      if (PGMessage && process.env.PG_HOST) {
        try {
          // Ensure bot user is synchronized to PostgreSQL users table
          await CommonlyBotService.syncBotUserToPostgreSQL(bot);

          // Create message in PostgreSQL (ensure podId is string)
          const newMessage = await PGMessage.create(
            podId.toString(),
            bot._id.toString(),
            messageContent,
            'text',
          );

          // Format message for consistency with MongoDB format
          message = {
            _id: newMessage.id,
            id: newMessage.id,
            content: newMessage.content,
            messageType: newMessage.message_type || 'text',
            userId: {
              _id: bot._id,
              username: bot.username,
              profilePicture: bot.profilePicture,
            },
            username: bot.username,
            profile_picture: bot.profilePicture,
            createdAt: newMessage.created_at,
            metadata: {
              source: 'discord-integration',
              integrationId,
              summaryType: discordSummary.summaryType || 'discord-hourly',
              originalMessageCount: discordSummary.messageCount || 0,
            },
          };

          console.log('✅ Discord summary message created in PostgreSQL');
        } catch (pgError) {
          console.error(
            'PostgreSQL message creation failed, falling back to MongoDB:',
            pgError,
          );

          // Fallback to MongoDB
          const mongoMessage = new Message({
            content: messageContent,
            userId: bot._id,
            podId,
            messageType: 'text',
            metadata: {
              source: 'discord-integration',
              integrationId,
              summaryType: discordSummary.summaryType || 'discord-hourly',
              originalMessageCount: discordSummary.messageCount || 0,
            },
          });

          await mongoMessage.save();
          await mongoMessage.populate('userId', 'username profilePicture');
          message = mongoMessage;

          console.log(
            '✅ Discord summary message created in MongoDB (fallback)',
          );
        }
      } else {
        // Use MongoDB
        const mongoMessage = new Message({
          content: messageContent,
          userId: bot._id,
          podId,
          messageType: 'text',
          metadata: {
            source: 'discord-integration',
            integrationId,
            summaryType: discordSummary.summaryType || 'discord-hourly',
            originalMessageCount: discordSummary.messageCount || 0,
          },
        });

        await mongoMessage.save();
        await mongoMessage.populate('userId', 'username profilePicture');
        message = mongoMessage;

        console.log('✅ Discord summary message created in MongoDB');
      }

      // Emit socket message so it appears in real-time
      try {
        const io = socketConfig.getIO();
        const formattedMessage = {
          _id: message._id || message.id,
          id: message._id || message.id,
          content: message.content,
          messageType: message.messageType || 'text',
          userId: message.userId || {
            _id: bot._id,
            username: bot.username,
            profilePicture: bot.profilePicture,
          },
          username: message.username || bot.username,
          profile_picture: message.profile_picture || bot.profilePicture,
          createdAt: message.createdAt,
          metadata: message.metadata,
        };

        console.log(
          `🎨 Bot user data - Username: ${formattedMessage.username}, ProfilePicture: ${formattedMessage.profile_picture}`,
        );

        io.to(`pod_${podId}`).emit('newMessage', formattedMessage);
        console.log(
          `📨 Discord summary posted to pod ${pod.name} by Commonly Bot (with socket emission)`,
        );
      } catch (socketError) {
        console.error('Failed to emit socket message:', socketError);
        console.log(
          `📨 Discord summary posted to pod ${pod.name} by Commonly Bot (without socket emission)`,
        );
      }

      return {
        success: true,
        message,
        pod,
      };
    } catch (error) {
      console.error('Error posting Discord summary to pod:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Format Discord summary for posting in Commonly pod
   * Uses ISO timestamps so frontend can display in user's local timezone
   */
  static formatDiscordSummaryForPod(discordSummary) {
    const messageCount = discordSummary.messageCount || 0;
    const serverName = discordSummary.serverName || 'Discord';
    const channelName = discordSummary.channelName || 'channel';
    const serverId = discordSummary.serverId || null;
    const channelId = discordSummary.channelId || null;

    // Store timestamps in ISO format for frontend parsing
    const startTime = discordSummary.timeRange?.start
      ? new Date(discordSummary.timeRange.start).toISOString()
      : null;
    const endTime = discordSummary.timeRange?.end
      ? new Date(discordSummary.timeRange.end).toISOString()
      : null;

    // Build Discord channel URL if we have the IDs
    const channelUrl = serverId && channelId
      ? `https://discord.com/channels/${serverId}/${channelId}`
      : null;

    // Use structured JSON format that frontend can parse and display nicely
    const botMessage = {
      type: 'discord-summary',
      channel: channelName,
      channelUrl,
      server: serverName,
      messageCount,
      timeRange: { start: startTime, end: endTime },
      summary: discordSummary.content,
    };

    // Return as JSON string with marker for frontend detection
    return `[BOT_MESSAGE]${JSON.stringify(botMessage)}`;
  }

  /**
   * Format external integration summary for posting in Commonly pod
   */
  static formatIntegrationSummaryForPod(summary) {
    const messageCount = summary.messageCount || 0;
    const source = summary.source || 'external';
    const sourceLabel = summary.sourceLabel || 'External';
    const channelName = summary.channelName || 'channel';
    const channelUrl = summary.channelUrl || null;

    const startTime = summary.timeRange?.start
      ? new Date(summary.timeRange.start).toISOString()
      : null;
    const endTime = summary.timeRange?.end
      ? new Date(summary.timeRange.end).toISOString()
      : null;

    const botMessage = {
      type: 'integration-summary',
      source,
      sourceLabel,
      channel: channelName,
      channelUrl,
      messageCount,
      timeRange: { start: startTime, end: endTime },
      summary: summary.content,
    };

    return `[BOT_MESSAGE]${JSON.stringify(botMessage)}`;
  }

  /**
   * Post an external integration summary to a Commonly pod
   */
  async postIntegrationSummaryToPod(podId, summary, integrationId) {
    try {
      const bot = await this.getBotUser();

      const pod = await Pod.findById(podId);
      if (!pod) {
        throw new Error(`Pod ${podId} not found`);
      }

      if (!pod.members.includes(bot._id)) {
        pod.members.push(bot._id);
        await pod.save();
      }

      const messageContent = CommonlyBotService.formatIntegrationSummaryForPod(
        summary,
      );

      let message;

      if (PGMessage && process.env.PG_HOST) {
        try {
          await CommonlyBotService.syncBotUserToPostgreSQL(bot);

          const newMessage = await PGMessage.create(
            podId.toString(),
            bot._id.toString(),
            messageContent,
            'text',
          );

          message = {
            _id: newMessage.id,
            id: newMessage.id,
            content: newMessage.content,
            messageType: newMessage.message_type || 'text',
            userId: {
              _id: bot._id,
              username: bot.username,
              profilePicture: bot.profilePicture,
            },
            username: bot.username,
            profile_picture: bot.profilePicture,
            createdAt: newMessage.created_at,
            metadata: {
              source: `${summary.source || 'external'}-integration`,
              integrationId,
              summaryType: `${summary.source || 'external'}-hourly`,
              originalMessageCount: summary.messageCount || 0,
            },
          };
        } catch (pgError) {
          console.error(
            'PostgreSQL message creation failed, falling back to MongoDB:',
            pgError,
          );

          const mongoMessage = new Message({
            content: messageContent,
            userId: bot._id,
            podId,
            messageType: 'text',
            metadata: {
              source: `${summary.source || 'external'}-integration`,
              integrationId,
              summaryType: `${summary.source || 'external'}-hourly`,
              originalMessageCount: summary.messageCount || 0,
            },
          });

          await mongoMessage.save();
          await mongoMessage.populate('userId', 'username profilePicture');
          message = mongoMessage;
        }
      } else {
        const mongoMessage = new Message({
          content: messageContent,
          userId: bot._id,
          podId,
          messageType: 'text',
          metadata: {
            source: `${summary.source || 'external'}-integration`,
            integrationId,
            summaryType: `${summary.source || 'external'}-hourly`,
            originalMessageCount: summary.messageCount || 0,
          },
        });

        await mongoMessage.save();
        await mongoMessage.populate('userId', 'username profilePicture');
        message = mongoMessage;
      }

      try {
        const io = socketConfig.getIO();
        const formattedMessage = {
          _id: message._id || message.id,
          id: message._id || message.id,
          content: message.content,
          messageType: message.messageType || 'text',
          userId: message.userId || {
            _id: bot._id,
            username: bot.username,
            profilePicture: bot.profilePicture,
          },
          username: message.username || bot.username,
          profile_picture: message.profile_picture || bot.profilePicture,
          createdAt: message.createdAt,
          metadata: message.metadata,
        };

        io.to(`pod_${podId}`).emit('newMessage', formattedMessage);
      } catch (socketError) {
        console.error('Failed to emit socket message:', socketError);
      }

      return {
        success: true,
        message,
        pod,
      };
    } catch (error) {
      console.error('Error posting integration summary to pod:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Post a general external integration update
   */
  async postIntegrationUpdate(
    podId,
    integrationName,
    updateContent,
    metadata = {},
  ) {
    try {
      const bot = await this.getBotUser();

      const pod = await Pod.findById(podId);
      if (!pod) {
        throw new Error(`Pod ${podId} not found`);
      }

      // Ensure bot is a member
      if (!pod.members.includes(bot._id)) {
        pod.members.push(bot._id);
        await pod.save();
      }

      const messageContent = `🔗 ${integrationName} Update

${updateContent}

—Commonly Bot 🤖`;

      let message;

      // Use PostgreSQL if available, otherwise fallback to MongoDB
      if (PGMessage && process.env.PG_HOST) {
        try {
          // Ensure bot user is synchronized to PostgreSQL users table
          await CommonlyBotService.syncBotUserToPostgreSQL(bot);

          // Create message in PostgreSQL (ensure podId is string)
          const newMessage = await PGMessage.create(
            podId.toString(),
            bot._id.toString(),
            messageContent,
            'text',
          );

          // Format message for consistency with MongoDB format
          message = {
            _id: newMessage.id,
            id: newMessage.id,
            content: newMessage.content,
            messageType: newMessage.message_type || 'text',
            userId: {
              _id: bot._id,
              username: bot.username,
              profilePicture: bot.profilePicture,
            },
            username: bot.username,
            profile_picture: bot.profilePicture,
            createdAt: newMessage.created_at,
            metadata: {
              source: 'external-integration',
              integrationType: integrationName.toLowerCase(),
              ...metadata,
            },
          };

          console.log('✅ Integration update message created in PostgreSQL');
        } catch (pgError) {
          console.error(
            'PostgreSQL message creation failed, falling back to MongoDB:',
            pgError,
          );

          // Fallback to MongoDB
          const mongoMessage = new Message({
            content: messageContent,
            userId: bot._id,
            podId,
            messageType: 'text',
            metadata: {
              source: 'external-integration',
              integrationType: integrationName.toLowerCase(),
              ...metadata,
            },
          });

          await mongoMessage.save();
          await mongoMessage.populate('userId', 'username profilePicture');
          message = mongoMessage;

          console.log(
            '✅ Integration update message created in MongoDB (fallback)',
          );
        }
      } else {
        // Use MongoDB
        const mongoMessage = new Message({
          content: messageContent,
          userId: bot._id,
          podId,
          messageType: 'text',
          metadata: {
            source: 'external-integration',
            integrationType: integrationName.toLowerCase(),
            ...metadata,
          },
        });

        await mongoMessage.save();
        await mongoMessage.populate('userId', 'username profilePicture');
        message = mongoMessage;

        console.log('✅ Integration update message created in MongoDB');
      }

      return {
        success: true,
        message,
        pod,
      };
    } catch (error) {
      console.error('Error posting integration update:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if bot user exists
   */
  async botExists() {
    const bot = await User.findOne({ username: this.BOT_USERNAME });
    return !!bot;
  }

  /**
   * Get bot user info for display
   */
  async getBotInfo() {
    const bot = await this.getBotUser();
    return {
      id: bot._id,
      username: bot.username,
      profilePicture: bot.profilePicture,
      role: bot.role,
      createdAt: bot.createdAt,
    };
  }

  /**
   * Sync bot user to PostgreSQL users table (only if not already synced)
   */
  static async syncBotUserToPostgreSQL(bot) {
    if (!PGMessage || !process.env.PG_HOST) {
      return; // PostgreSQL not available
    }

    try {
      const { pool } = dbPg;

      // Check if bot user already exists in PostgreSQL
      const checkQuery = 'SELECT _id FROM users WHERE _id = $1';
      const checkResult = await pool.query(checkQuery, [bot._id.toString()]);

      if (checkResult.rows.length > 0) {
        return; // User already exists, no need to sync
      }

      // Insert bot user in PostgreSQL users table (first time only)
      const insertQuery = `
        INSERT INTO users (_id, username, profile_picture, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
      `;

      await pool.query(insertQuery, [
        bot._id.toString(),
        bot.username,
        bot.profilePicture,
        bot.createdAt,
        new Date(),
      ]);

      console.log(`✅ Bot user synchronized to PostgreSQL: ${bot.username}`);
    } catch (error) {
      console.error('Failed to sync bot user to PostgreSQL:', error);
    }
  }
}

module.exports = CommonlyBotService;
