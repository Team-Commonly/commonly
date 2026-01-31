const User = require('../models/User');
const Pod = require('../models/Pod');

// PostgreSQL connection
let dbPg;
try {
  // eslint-disable-next-line global-require
  dbPg = require('../config/db-pg');
} catch (error) {
  dbPg = null;
}

// PostgreSQL Message model presence indicates PG users table is available
let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  PGMessage = null;
}

let PGPod;
try {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
} catch (error) {
  PGPod = null;
}

const normalizeSegment = (value) => (
  (value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)
);

const buildAgentUsername = (agentName, instanceId) => {
  const normalized = normalizeSegment(agentName);
  const instance = normalizeSegment(instanceId);
  if (!instance || instance === 'default') {
    return normalized || 'agent';
  }
  return `${normalized}-${instance}`;
};

const buildAgentEmail = (agentName, instanceId) => {
  const username = buildAgentUsername(agentName, instanceId);
  return `${username || 'agent'}@agents.commonly.local`;
};

// Official Commonly agents with cute display names
const OFFICIAL_AGENTS = {
  'commonly-ai-agent': {
    displayName: 'Cuz 🤙',
    description: 'Commonly central bot for integrations, notifications, and support',
    botType: 'system',
    capabilities: ['notify', 'summarize', 'integrate'],
  },
  'commonly-bot': {
    displayName: 'Commonly Summarizer',
    description: 'Lightweight summarizer bot for integrations and pod activity',
    botType: 'system',
    capabilities: ['notify', 'summarize', 'integrate'],
  },
  'clawd-bot': {
    displayName: 'Clawd 🐾',
    description: 'Your friendly AI assistant powered by Claude - ready to chat, help, and remember!',
    botType: 'agent',
    capabilities: ['chat', 'memory', 'context', 'summarize'],
  },
};

class AgentIdentityService {
  /**
   * Get or create an agent user with proper bot metadata
   * @param {string} agentName - The agent's username (e.g., 'clawd-bot')
   * @param {object} options - Optional metadata overrides
   * @param {string} options.displayName - Custom display name
   * @param {string} options.description - Custom description
   * @param {string} options.runtimeId - Unique runtime instance ID
   * @param {string[]} options.capabilities - Agent capabilities
   */
  static async getOrCreateAgentUser(agentName, options = {}) {
    if (!agentName) {
      throw new Error('agentName is required');
    }

    const instanceId = options.instanceId || 'default';
    const username = buildAgentUsername(agentName, instanceId);
    let agentUser = await User.findOne({ username });

    // Check if this is an official agent
    const officialConfig = OFFICIAL_AGENTS[username];
    const isOfficial = !!officialConfig;

    if (!agentUser) {
      const botMetadata = {
        displayName: options.displayName || officialConfig?.displayName || agentName,
        description: options.description || officialConfig?.description || `${agentName} agent`,
        runtimeId: options.runtimeId || null,
        officialAgent: isOfficial,
        capabilities: options.capabilities || officialConfig?.capabilities || [],
        agentName: agentName.toLowerCase(),
        instanceId,
      };

      agentUser = new User({
        username,
        email: buildAgentEmail(agentName, instanceId),
        password: `agent-password-${Date.now()}`,
        verified: true,
        profilePicture: 'default',
        role: 'user',
        isBot: true,
        botType: officialConfig?.botType || options.botType || 'agent',
        botMetadata,
      });

      await agentUser.save();
      console.log(`Created bot user: ${username} (${botMetadata.displayName})`);
    } else if (!agentUser.isBot) {
      // Upgrade existing user to bot if not already marked
      agentUser.isBot = true;
      agentUser.botType = officialConfig?.botType || options.botType || 'agent';
      agentUser.botMetadata = {
        displayName: options.displayName || officialConfig?.displayName || agentUser.username,
        description: options.description || officialConfig?.description || `${agentName} agent`,
        runtimeId: options.runtimeId || agentUser.botMetadata?.runtimeId || null,
        officialAgent: isOfficial,
        capabilities: options.capabilities || officialConfig?.capabilities || [],
        agentName: agentName.toLowerCase(),
        instanceId,
      };
      await agentUser.save();
      console.log(`Upgraded user to bot: ${username}`);
    }

    return agentUser;
  }

  /**
   * Get official agent configuration
   */
  static getOfficialAgents() {
    return { ...OFFICIAL_AGENTS };
  }

  /**
   * Check if an agent name is an official Commonly agent
   */
  static isOfficialAgent(agentName) {
    return !!OFFICIAL_AGENTS[agentName?.toLowerCase()];
  }

  static buildAgentUsername(agentName, instanceId) {
    return buildAgentUsername(agentName, instanceId);
  }

  static async ensureAgentInPod(agentUser, podId) {
    if (!agentUser || !podId) return null;
    const pod = await Pod.findById(podId);
    if (!pod) return null;
    if (!pod.members.includes(agentUser._id)) {
      pod.members.push(agentUser._id);
      await pod.save();
    }
    return pod;
  }

  static async removeAgentFromPod(agentName, podId) {
    if (!agentName || !podId) return null;
    const username = agentName.toLowerCase();
    const agentUser = await User.findOne({ username });
    if (!agentUser) return null;

    const pod = await Pod.findById(podId);
    if (!pod) return null;

    const agentId = agentUser._id.toString();
    const hadMember = pod.members?.some((member) => member.toString() === agentId);
    if (hadMember) {
      pod.members = pod.members.filter((member) => member.toString() !== agentId);
      await pod.save();
    }

    if (process.env.PG_HOST && PGPod) {
      try {
        await PGPod.removeMember(podId, agentId);
      } catch (error) {
        console.warn('Failed to remove agent from PostgreSQL pod members:', error.message);
      }
    }

    return pod;
  }

  static async syncUserToPostgreSQL(user) {
    if (!PGMessage || !process.env.PG_HOST || !dbPg) return;
    try {
      const { pool } = dbPg;
      const checkQuery = 'SELECT _id FROM users WHERE _id = $1';
      const checkResult = await pool.query(checkQuery, [user._id.toString()]);

      // For bot users, use display name as username for better UX
      const displayUsername = user.isBot && user.botMetadata?.displayName
        ? user.botMetadata.displayName
        : user.username;

      if (checkResult.rows.length > 0) {
        // Update existing record if it's a bot (to sync display name)
        if (user.isBot) {
          const updateQuery = `
            UPDATE users SET username = $2, updated_at = $3 WHERE _id = $1
          `;
          await pool.query(updateQuery, [
            user._id.toString(),
            displayUsername,
            new Date(),
          ]);
        }
        return;
      }

      const insertQuery = `
        INSERT INTO users (_id, username, profile_picture, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
      `;

      await pool.query(insertQuery, [
        user._id.toString(),
        displayUsername,
        user.profilePicture,
        user.createdAt,
        new Date(),
      ]);
    } catch (error) {
      console.error('Failed to sync agent user to PostgreSQL:', error);
    }
  }
}

module.exports = AgentIdentityService;
