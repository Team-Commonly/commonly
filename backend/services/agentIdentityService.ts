import User from '../models/User';
import Pod from '../models/Pod';

let dbPg: { pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } } | null;
try {
  // eslint-disable-next-line global-require
  dbPg = require('../config/db-pg');
} catch (error) {
  dbPg = null;
}

let PGMessage: unknown | null;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  PGMessage = null;
}

let PGPod: { removeMember: (podId: unknown, userId: string) => Promise<void> } | null;
try {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
} catch (error) {
  PGPod = null;
}

const normalizeSegment = (value: unknown): string => (
  (String(value || '')).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)
);

const buildAgentUsername = (agentType: string, instanceId: string): string => {
  const normalized = normalizeSegment(agentType);
  const instance = normalizeSegment(instanceId);
  if (!instance || instance === 'default' || instance === normalized) {
    return normalized || 'agent';
  }
  return `${normalized}-${instance}`;
};

const buildAgentEmail = (agentType: string, instanceId: string): string => {
  const username = buildAgentUsername(agentType, instanceId);
  return `${username || 'agent'}@agents.commonly.local`;
};

interface AgentTypeConfig {
  officialDisplayName: string;
  officialDescription: string;
  icon: string;
  botType: string;
  capabilities: string[];
  /**
   * Runtime driver selector. Must be one of the runtimeType values handled
   * by `provisionAgentRuntime` in `agentProvisionerServiceK8s.ts` /
   * `agentProvisionerService.ts`:
   *   - 'moltbot'         — OpenClaw gateway (shared k8s deployment)
   *   - 'internal'        — Commonly-bot (in-process)
   *   - 'webhook'         — external HTTP endpoint (no deploy)
   *   - 'claude-code'     — external Claude Code session (no deploy)
   *   - 'openai'          — OpenAI Codex (LiteLLM-proxied, no deploy)
   *   - 'managed-agents'  — Anthropic Claude Managed Agents API (beta,
   *                         see `managedAgentsAdapter.ts`; scaffolding only
   *                         as of 2026-04-11 — requires a real
   *                         ANTHROPIC_API_KEY to activate)
   */
  runtime: string;
}

const AGENT_TYPES: Record<string, AgentTypeConfig> = {
  openclaw: {
    officialDisplayName: 'Cuz 🦞',
    officialDescription: 'Your friendly AI assistant powered by Claude - ready to chat, help, and remember!',
    icon: '🦞',
    botType: 'agent',
    capabilities: ['chat', 'memory', 'context', 'summarize', 'code'],
    runtime: 'moltbot',
  },
  'commonly-bot': {
    officialDisplayName: 'Commonly Bot',
    officialDescription: 'Built-in summary bot for integrations, pod activity, and digest context',
    icon: '📋',
    botType: 'system',
    capabilities: ['notify', 'summarize', 'integrate', 'digest'],
    runtime: 'internal',
  },
  'commonly-summarizer': {
    officialDisplayName: 'Commonly Summarizer (Legacy)',
    officialDescription: 'Legacy alias for Commonly Bot',
    icon: '📋',
    botType: 'system',
    capabilities: ['notify', 'summarize', 'integrate', 'digest'],
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
  newshound: {
    officialDisplayName: 'NewsHound 🐕',
    officialDescription: 'News aggregation and analysis agent - curious, thorough, analytical',
    icon: '🐕',
    botType: 'agent',
    capabilities: ['news', 'search', 'summarize', 'analyze', 'trends'],
    runtime: 'moltbot',
  },
  socialpulse: {
    officialDisplayName: 'SocialPulse 📊',
    officialDescription: 'Social media monitoring and sentiment analysis agent - trendy, observant, conversational',
    icon: '📊',
    botType: 'agent',
    capabilities: ['social', 'trends', 'sentiment', 'monitor', 'analyze'],
    runtime: 'moltbot',
  },
};

// Legacy agent name mapping is intentionally disabled to avoid alias collisions.
const LEGACY_AGENT_MAP: Record<string, string> = {
  'commonly-summarizer': 'commonly-bot',
};

interface GetOrCreateOptions {
  displayName?: string;
  description?: string;
  instanceId?: string;
  runtimeId?: string;
  capabilities?: string[];
  botType?: string;
}

class AgentIdentityService {
  /**
   * Get or create an agent user with proper bot metadata
   */
  static async getOrCreateAgentUser(agentType: string, options: GetOrCreateOptions = {}): Promise<InstanceType<typeof User>> {
    if (!agentType) {
      throw new Error('agentType is required');
    }

    // Handle legacy agent names
    const resolvedType = AgentIdentityService.resolveAgentType(agentType);
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
        agentName: resolvedType,
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
      agentUser.botType = (typeConfig?.botType || options.botType || 'agent') as typeof agentUser.botType;
      agentUser.botMetadata = {
        displayName: options.displayName || typeConfig?.officialDisplayName || agentUser.username,
        description: options.description || typeConfig?.officialDescription || `${resolvedType} agent`,
        icon: typeConfig?.icon || '🤖',
        runtimeId: options.runtimeId || agentUser.botMetadata?.runtimeId || undefined,
        officialAgent: isOfficial,
        capabilities: options.capabilities || typeConfig?.capabilities || [],
        agentName: resolvedType,
        instanceId,
        runtime: typeConfig?.runtime || 'unknown',
      };
      await agentUser.save();
      console.log(`Upgraded user to bot: ${username}`);
    } else {
      const existingMeta = agentUser.botMetadata || {};
      const requestedDisplayName = options.displayName
        ? String(options.displayName).trim()
        : '';
      const needsUpdate = !existingMeta.agentName
        || existingMeta.agentName !== resolvedType
        || existingMeta.instanceId !== instanceId
        || !existingMeta.runtime
        || (requestedDisplayName && existingMeta.displayName !== requestedDisplayName);
      if (needsUpdate) {
        agentUser.botMetadata = {
          ...existingMeta,
          displayName: options.displayName || existingMeta.displayName || typeConfig?.officialDisplayName || resolvedType,
          description: options.description || existingMeta.description || typeConfig?.officialDescription || `${resolvedType} agent`,
          icon: existingMeta.icon || typeConfig?.icon || '🤖',
          runtimeId: options.runtimeId || existingMeta.runtimeId || undefined,
          officialAgent: instanceId === 'default' && !!typeConfig,
          capabilities: options.capabilities || existingMeta.capabilities || typeConfig?.capabilities || [],
          agentName: resolvedType,
          instanceId,
          runtime: existingMeta.runtime || typeConfig?.runtime || 'unknown',
        };
        await agentUser.save();
        console.log(`Refreshed bot metadata: ${username}`);
      }
    }

    return agentUser;
  }

  static getAgentTypes(): Record<string, AgentTypeConfig> {
    return { ...AGENT_TYPES };
  }

  static getAgentTypeConfig(agentType: string): AgentTypeConfig | null {
    const resolvedType = this.resolveAgentType(agentType);
    return AGENT_TYPES[resolvedType] || null;
  }

  static isKnownAgentType(agentType: string): boolean {
    const resolvedType = this.resolveAgentType(agentType);
    return !!AGENT_TYPES[resolvedType];
  }

  static resolveAgentType(agentNameOrType: string): string {
    const normalized = agentNameOrType?.toLowerCase();
    return LEGACY_AGENT_MAP[normalized] || normalized;
  }

  static buildAgentUsername(agentType: string, instanceId: string): string {
    return buildAgentUsername(agentType, instanceId);
  }

  static async ensureAgentInPod(agentUser: InstanceType<typeof User>, podId: unknown): Promise<InstanceType<typeof Pod> | null> {
    if (!agentUser || !podId) return null;
    const pod = await Pod.findById(podId);
    if (!pod) return null;
    if (!pod.members.includes(agentUser._id)) {
      // Agent DMs are 1:1 (ADR-001 §3.10). Auto-install paths must not
      // sneak a third member into someone else's agent-room — the room
      // already has exactly its host agent + one human. If the requested
      // agent isn't already in this room, refuse to add. Caller should
      // create a NEW agent-room for this agent + user pair instead.
      if (pod.type === 'agent-room') {
        console.warn(
          `[ensureAgentInPod] refused: pod ${pod._id} is an agent-room (1:1) `
          + `and agent ${agentUser._id} is not already a member. ADR-001 §3.10.`,
        );
        return null;
      }
      pod.members.push(agentUser._id);
      await pod.save();
    }
    return pod;
  }

  static async removeAgentFromPod(agentType: string, podId: unknown, instanceId = 'default'): Promise<InstanceType<typeof Pod> | null> {
    if (!agentType || !podId) return null;
    const username = buildAgentUsername(agentType, instanceId);
    const agentUser = await User.findOne({ username });
    if (!agentUser) return null;

    const pod = await Pod.findById(podId);
    if (!pod) return null;

    const agentId = agentUser._id.toString();
    const hadMember = pod.members?.some((member: unknown) => String(member).toString() === agentId);
    if (hadMember) {
      pod.members = pod.members.filter((member: unknown) => String(member).toString() !== agentId);
      await pod.save();
    }

    if (process.env.PG_HOST && PGPod) {
      try {
        await PGPod.removeMember(podId, agentId);
      } catch (error) {
        console.warn('Failed to remove agent from PostgreSQL pod members:', (error as Error).message);
      }
    }

    return pod;
  }

  static async syncUserToPostgreSQL(user: InstanceType<typeof User>): Promise<void> {
    if (!PGMessage || !process.env.PG_HOST || !dbPg) return;
    try {
      const { pool } = dbPg;
      const checkQuery = 'SELECT _id FROM users WHERE _id = $1';
      const checkResult = await pool.query(checkQuery, [user._id.toString()]);

      // For bot users, use display name as username for better UX
      const displayUsername = user.isBot && user.botMetadata?.displayName
        ? user.botMetadata.displayName
        : user.username;

      const isBot = user.isBot === true;

      if (checkResult.rows.length > 0) {
        const updateQuery = `
          UPDATE users
          SET username = $2, profile_picture = $3, is_bot = $4, updated_at = $5
          WHERE _id = $1
        `;
        await pool.query(updateQuery, [
          user._id.toString(),
          displayUsername,
          user.profilePicture || null,
          isBot,
          new Date(),
        ]);
        return;
      }

      const insertQuery = `
        INSERT INTO users (_id, username, profile_picture, is_bot, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;

      await pool.query(insertQuery, [
        user._id.toString(),
        displayUsername,
        user.profilePicture,
        isBot,
        user.createdAt,
        new Date(),
      ]);
    } catch (error) {
      console.error('Failed to sync agent user to PostgreSQL:', error);
    }
  }
}

export default AgentIdentityService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
