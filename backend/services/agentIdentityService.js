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

const buildAgentUsername = (agentType, instanceId) => {
  const normalized = normalizeSegment(agentType);
  const instance = normalizeSegment(instanceId);
  if (!instance || instance === 'default') {
    return normalized || 'agent';
  }
  return `${normalized}-${instance}`;
};

const buildAgentEmail = (agentType, instanceId) => {
  const username = buildAgentUsername(agentType, instanceId);
  return `${username || 'agent'}@agents.commonly.local`;
};

/**
 * Agent Type Registry
 *
 * agentType = the runtime/engine type (what powers the agent)
 * Each type can have an official "in-house" display name and custom user instances
 *
 * Types:
 * - openclaw: Claude-powered conversational AI (official: "Cuz 🦞")
 * - commonly-summarizer: Lightweight summarization bot (official: "Commonly Summarizer")
 * - claude-code: Claude Code integration (future)
 * - codex: OpenAI Codex integration (future)
 */
const AGENT_TYPES = {
  openclaw: {
    officialDisplayName: 'Cuz 🦞',
    officialDescription: 'Your friendly AI assistant powered by Claude - ready to chat, help, and remember!',
    icon: '🦞',
    botType: 'agent',
    capabilities: ['chat', 'memory', 'context', 'summarize', 'code'],
    runtime: 'moltbot',
  },
  'commonly-summarizer': {
    officialDisplayName: 'Commonly Summarizer',
    officialDescription: 'Lightweight summarizer bot for integrations and pod activity',
    icon: '📋',
    botType: 'system',
    capabilities: ['notify', 'summarize', 'integrate'],
    runtime: 'internal',
  },
  'claude-code': {
    officialDisplayName: 'Claude Code',
    officialDescription: 'Claude Code integration for development assistance',
    icon: '💻',
    botType: 'agent',
    capabilities: ['code', 'chat', 'memory'],
    runtime: 'claude-code',
  },
  codex: {
    officialDisplayName: 'Codex',
    officialDescription: 'OpenAI Codex integration for code generation',
    icon: '🤖',
    botType: 'agent',
    capabilities: ['code', 'chat'],
    runtime: 'openai',
  },
};

// Backwards compatibility: map old agent names to new types
const LEGACY_AGENT_MAP = {
  'clawd-bot': 'openclaw',
  'commonly-bot': 'commonly-summarizer',
  'commonly-ai-agent': 'openclaw',
};

class AgentIdentityService {
  /**
   * Get or create an agent user with proper bot metadata
   * @param {string} agentType - The agent type (e.g., 'openclaw', 'commonly-summarizer')
   * @param {object} options - Optional metadata overrides
   * @param {string} options.displayName - Custom display name (defaults to official)
   * @param {string} options.description - Custom description
   * @param {string} options.instanceId - Instance identifier for multi-install
   * @param {string} options.runtimeId - Unique runtime instance ID
   * @param {string[]} options.capabilities - Agent capabilities
   */
  static async getOrCreateAgentUser(agentType, options = {}) {
    if (!agentType) {
      throw new Error('agentType is required');
    }

    // Handle legacy agent names
    const resolvedType = LEGACY_AGENT_MAP[agentType.toLowerCase()] || agentType.toLowerCase();
    const typeConfig = AGENT_TYPES[resolvedType];

    const instanceId = options.instanceId || 'default';
    const username = buildAgentUsername(resolvedType, instanceId);
    let agentUser = await User.findOne({ username });

    // Determine if this is an official (default instance) agent
    const isOfficial = instanceId === 'default' && !!typeConfig;

    if (!agentUser) {
      const botMetadata = {
        displayName: options.displayName || typeConfig?.officialDisplayName || resolvedType,
        description: options.description || typeConfig?.officialDescription || `${resolvedType} agent`,
        icon: typeConfig?.icon || '🤖',
        runtimeId: options.runtimeId || null,
        officialAgent: isOfficial,
        capabilities: options.capabilities || typeConfig?.capabilities || [],
        agentType: resolvedType,
        instanceId,
        runtime: typeConfig?.runtime || 'unknown',
      };

      agentUser = new User({
        username,
        email: buildAgentEmail(resolvedType, instanceId),
        password: `agent-password-${Date.now()}`,
        verified: true,
        profilePicture: 'default',
        role: 'user',
        isBot: true,
        botType: typeConfig?.botType || options.botType || 'agent',
        botMetadata,
      });

      await agentUser.save();
      console.log(`Created bot user: ${username} (${botMetadata.displayName})`);
    } else if (!agentUser.isBot) {
      // Upgrade existing user to bot if not already marked
      agentUser.isBot = true;
      agentUser.botType = typeConfig?.botType || options.botType || 'agent';
      agentUser.botMetadata = {
        displayName: options.displayName || typeConfig?.officialDisplayName || agentUser.username,
        description: options.description || typeConfig?.officialDescription || `${resolvedType} agent`,
        icon: typeConfig?.icon || '🤖',
        runtimeId: options.runtimeId || agentUser.botMetadata?.runtimeId || null,
        officialAgent: isOfficial,
        capabilities: options.capabilities || typeConfig?.capabilities || [],
        agentType: resolvedType,
        instanceId,
        runtime: typeConfig?.runtime || 'unknown',
      };
      await agentUser.save();
      console.log(`Upgraded user to bot: ${username}`);
    }

    return agentUser;
  }

  /**
   * Get all registered agent types
   */
  static getAgentTypes() {
    return { ...AGENT_TYPES };
  }

  /**
   * Get configuration for a specific agent type
   */
  static getAgentTypeConfig(agentType) {
    const resolvedType = LEGACY_AGENT_MAP[agentType?.toLowerCase()] || agentType?.toLowerCase();
    return AGENT_TYPES[resolvedType] || null;
  }

  /**
   * Check if an agent type is a known/official type
   */
  static isKnownAgentType(agentType) {
    const resolvedType = LEGACY_AGENT_MAP[agentType?.toLowerCase()] || agentType?.toLowerCase();
    return !!AGENT_TYPES[resolvedType];
  }

  /**
   * Resolve legacy agent name to current agent type
   */
  static resolveAgentType(agentNameOrType) {
    return LEGACY_AGENT_MAP[agentNameOrType?.toLowerCase()] || agentNameOrType?.toLowerCase();
  }

  static buildAgentUsername(agentType, instanceId) {
    return buildAgentUsername(agentType, instanceId);
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

  static async removeAgentFromPod(agentType, podId, instanceId = 'default') {
    if (!agentType || !podId) return null;
    const username = buildAgentUsername(agentType, instanceId);
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
