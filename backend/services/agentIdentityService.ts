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

// Pod types that are strictly 1:1 — exactly two members, no joinable widen.
// Adding a third party to one of these is a bug; a new conversation always
// spawns a fresh DM pod (see dmService.getOrCreateAgentDmRoom). Single source
// of truth for ALL membership-add paths (ensureAgentInPod, joinPod controller,
// claude-code attach in registry/admin, any future code).
//
// `agent-admin` is intentionally NOT in this set — multiple admins can share
// an admin↔agent pod (it's an N:1 admin-team DM, not a strict 1:1).
//
// Why it lives here: agentIdentityService.ensureAgentInPod is the most-called
// add-path and the original site of the agent-room guard, so co-locating the
// invariant keeps the rule visible to anyone reading that function.
export const DM_POD_TYPES_GUARD = new Set<string>(['agent-room', 'agent-dm']);

// Resolve the human-readable label for an agent User row. The fallback
// chain is intentional and load-bearing for any UI / pod-naming surface
// that shows agent identity (agent-dm pod names, sidebar member rows):
//
//   1. `botMetadata.displayName`  — the curated label the registry/preset
//      sets ("Pixel", "Strategist (Aria)"). This is what humans actually
//      recognize.
//   2. `botMetadata.instanceId`   — when displayName is missing AND the
//      instanceId carries identity (i.e. != 'default'). For OpenClaw-driven
//      agents the User row stores `agentName: 'openclaw'` (the RUNTIME) +
//      `instanceId: 'aria' | 'pixel' | ...` (the identity), so falling back
//      to instanceId here beats falling back to the runtime label.
//   3. `username`                 — last-resort identifier; always set.
//   4. fallback string            — for the non-User case (e.g. resolved-
//      by-alias before the User row is loaded).
//
// Why NOT fall back to `botMetadata.agentName`: that field can be the
// runtime name ('openclaw') rather than the agent's identity. Falling
// back to it produces "openclaw ↔ openclaw" pod names where what we want
// is "Pixel ↔ Strategist (Aria)".
export function resolveAgentDisplayLabel(
  user: {
    username?: string;
    botMetadata?: { displayName?: string; instanceId?: string; agentName?: string };
  } | null | undefined,
  fallback?: string,
): string {
  const safeFallback = fallback || 'agent';
  if (!user) return safeFallback;
  const meta = user.botMetadata;
  const display = meta?.displayName?.trim();
  const agentName = meta?.agentName?.trim() || '';
  const instanceId = meta?.instanceId?.trim() || '';
  // Leak-pattern detection. If displayName is literally `<agentName> (<instanceId>)`
  // (e.g. "openclaw (nova)"), it's the runtime label leaking through — some
  // historical writer formatted displayName as `${agentName} (${instanceId})`
  // instead of using the curated label. Treat these as if displayName were
  // missing and fall through to instanceId. Matches both the
  // `<runtime> (<instance>)` form and the bare `<runtime>` form
  // (e.g. displayName === 'openclaw'). Also catches the case where
  // displayName equals just instanceId — the chain below would render the
  // same thing, but we drop the redundant pass here.
  const leakedPattern = (
    !!display
    && !!agentName
    && (
      display.toLowerCase() === agentName.toLowerCase()
      || (
        !!instanceId
        && display.toLowerCase() === `${agentName.toLowerCase()} (${instanceId.toLowerCase()})`
      )
    )
  );
  if (display && !leakedPattern) return display;
  if (instanceId && instanceId !== 'default') return instanceId;
  if (user.username) return user.username;
  return safeFallback;
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
   * Identity-bearing runtime tag. Pairs with `host` (`'cloud' | 'byo'`) on
   * the install record (`config.runtime.host`) to fully classify a driver:
   * the same `runtimeType` can run cloud-hosted (Commonly-managed) or BYO
   * (user laptop / their server, polling CAP). AGENT_TYPES entries describe
   * the cloud / first-party variant; `host: 'cloud'` is implicit for
   * built-ins. CLI-attached agents (`commonly agent attach`) write the same
   * `runtimeType` with `host: 'byo'` — see `cli/src/lib/adapters/<name>.js`.
   *
   *   - 'moltbot'        — OpenClaw gateway (shared k8s deployment)
   *   - 'internal'       — Commonly-bot (in-process)
   *   - 'webhook'        — external HTTP endpoint (no deploy)
   *   - 'claude-code'    — Claude Code (cloud variant has no deploy yet;
   *                        CLI variant is sam-local-claude et al.)
   *   - 'codex'          — OpenAI Codex (cloud = LiteLLM-proxied; CLI =
   *                        sam-local-codex et al.). Legacy `openai` value
   *                        still resolves via the normalizer in
   *                        `routes/registry/helpers.ts`.
   *   - 'managed-agents' — Anthropic Claude Managed Agents API (beta,
   *                        scaffolding only).
   *
   * Legacy `runtimeType: 'local-cli'` + `wrappedCli` (pre-2026-05-04 CLI
   * attach) is normalized to `runtimeType: <wrappedCli>` + `host: 'byo'`
   * at read time — installations on disk are not migrated.
   */
  runtime: string;
}

const AGENT_TYPES: Record<string, AgentTypeConfig> = {
  openclaw: {
    officialDisplayName: 'Cuz 🦞',
    // Don't claim a model here. OpenClaw agents route through LiteLLM and the
    // active model depends on per-agent overrides (dev agents on
    // openai-codex/gpt-5.4, community agents on OpenRouter free tier, etc.).
    // The previous "powered by Claude" string was both wrong (we are not
    // Anthropic) and misleading (community agents aren't on Claude). Keep the
    // description capability-flavored so it still fits the no-blurb fallback
    // template in registry/install.ts.
    officialDescription: 'OpenClaw cloud agent — chat, remember, take real actions when you need it.',
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
    // Identity tag matches the CLI adapter's runtimeType so a CLI-attached
    // Codex agent and a hosted Codex agent share runtimeType, differing
    // only on `host` (BYO vs cloud). Legacy value `openai` (provider-
    // leaning) still resolves via the normalizer in registry/helpers.ts.
    runtime: 'codex',
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

// Cloud-hosted runtime types — the ones that consume Commonly-managed compute
// (shared k8s gateway, in-process native runtime, Anthropic managed-agents).
// This is the single source of truth for the hosted-agent entitlement gate
// (see routes/registry/install.ts + provision.ts). Installing/provisioning any
// runtime in this set requires `user.entitlements.cloudAgents` (or admin) so
// that open registration can be turned on later without handing every new
// signup free hosted compute. BYO / self-hosted runtimes (webhook, claude-code,
// or anything carrying `host: 'byo'`) are intentionally NOT gated — connecting
// your own agent stays open to all authenticated users.
//
// `codex` is deliberately absent: a codex install is cloud-hosted by default
// (LiteLLM-proxied) but flips to BYO when `host === 'byo'` (sam-local-codex et
// al.), so it's classified in isCloudRuntime() rather than by set membership.
export const CLOUD_RUNTIME_TYPES = new Set<string>([
  'moltbot',
  'internal',
  'native',
  'managed-agents',
]);

/**
 * Classify an install/provision runtime as cloud-hosted (gated) vs BYO (open).
 * Pure function over the two fields the install record stores on
 * `config.runtime`: `runtimeType` and `host`.
 *
 * Decision order is load-bearing:
 *   1. `host: 'byo'` ALWAYS wins → NON-cloud. When a user points Commonly at
 *      their own compute (laptop CLI wrapper, their own server polling CAP) the
 *      install record carries `host: 'byo'`. That path must stay open to every
 *      authenticated user regardless of `runtimeType`, so this is checked first.
 *   2. `webhook` / `claude-code` are pure BYO runtime types (no Commonly-hosted
 *      variant exists) → NON-cloud.
 *   3. Anything in CLOUD_RUNTIME_TYPES (moltbot/internal/native/managed-agents)
 *      → cloud.
 *   4. `codex` with no `host: 'byo'` (handled in step 1) → cloud (LiteLLM-proxied).
 *   5. Everything else (unknown / unspecified runtimeType, e.g. a generic
 *      standalone marketplace agent that brings its own compute) → NON-cloud.
 *      Callers that want a built-in cloud agent caught even when the install
 *      omits an explicit runtimeType should resolve the effective runtimeType
 *      from AGENT_TYPES first (getAgentTypeConfig(name)?.runtime).
 */
export function isCloudRuntime(
  runtime: { runtimeType?: string | null; host?: string | null } | null | undefined,
): boolean {
  const runtimeType = String(runtime?.runtimeType || '').trim().toLowerCase();
  const host = String(runtime?.host || '').trim().toLowerCase();
  if (host === 'byo') return false;
  if (runtimeType === 'webhook' || runtimeType === 'claude-code') return false;
  if (CLOUD_RUNTIME_TYPES.has(runtimeType)) return true;
  if (runtimeType === 'codex') return true;
  return false;
}

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

/**
 * Disambiguate an agent's displayName at WRITE time so it doesn't collide
 * with another bot User row's displayName. Mirrors the offline dedup
 * script's logic (scripts/dedupe-agent-display-names.ts) but runs inline
 * during getOrCreateAgentUser so a fresh install / reprovision can never
 * (re-)introduce a "Pixel" / "Pixel" collision.
 *
 * Canonical rule (matches the one-shot script — keep these aligned):
 *   - Group claimants by displayName.
 *   - Canonical = shortest instanceId; alphabetical tiebreak.
 *   - Non-canonical entries get suffixed `"<base> (<HumanizedInstanceId>)"`.
 *
 * This call returns the disambiguated name the CURRENT caller should use.
 * It does NOT rewrite peers — for the "new shorter instanceId arrives
 * after a longer one" edge case, re-run the offline dedup script as a
 * sweep. In practice the inline check covers the common path: demo /
 * stub variants installed after a canonical agent.
 *
 * `selfUserId` is passed when the caller is updating an existing row so
 * we don't compare it against itself (would always return canonical and
 * never apply a suffix).
 */
async function resolveCollisionFreeDisplayName(
  desiredName: string,
  instanceId: string,
  selfUserId?: unknown,
): Promise<string> {
  const trimmed = (desiredName || '').trim();
  if (!trimmed) return trimmed;
  // If the name already carries a parenthetical suffix, treat as
  // already-disambiguated and pass through. Avoids "Pixel (Pixel-Demo) (Pixel-Demo)"
  // loops when the same install reprovisions.
  if (/\([^)]+\)\s*$/.test(trimmed)) return trimmed;

  const peerQuery: Record<string, unknown> = {
    'botMetadata.displayName': trimmed,
  };
  if (selfUserId) {
    peerQuery._id = { $ne: selfUserId };
  }
  const peers = await User.find(peerQuery)
    .select('botMetadata')
    .lean<Array<{ botMetadata?: { instanceId?: string } }>>();
  if (peers.length === 0) return trimmed;

  // Include `self` in the canonical-pick comparison so the rule is stable
  // regardless of which row writes first.
  const all = [
    ...peers.map((p) => p.botMetadata?.instanceId || ''),
    instanceId,
  ];
  const canonical = [...all].sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  })[0];
  if (canonical === instanceId) {
    // Caller is the canonical; let them keep the bare name. Peers may
    // need rewriting via the offline sweep — see comment above.
    return trimmed;
  }
  const humanizedInstance = (instanceId || '')
    .split(/[-_]/)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('-');
  return `${trimmed} (${humanizedInstance})`;
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
      const rawDisplayName = options.displayName || typeConfig?.officialDisplayName || resolvedType;
      const botMetadata = {
        displayName: await resolveCollisionFreeDisplayName(rawDisplayName, instanceId),
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
      const upgradeRawDisplayName = options.displayName || typeConfig?.officialDisplayName || agentUser.username;
      agentUser.botMetadata = {
        displayName: await resolveCollisionFreeDisplayName(upgradeRawDisplayName, instanceId, agentUser._id),
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
        const refreshRawDisplayName = options.displayName || existingMeta.displayName || typeConfig?.officialDisplayName || resolvedType;
        agentUser.botMetadata = {
          ...existingMeta,
          displayName: await resolveCollisionFreeDisplayName(refreshRawDisplayName, instanceId, agentUser._id),
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

    // ObjectId equality: Mongoose stores `pod.members` as an array of
    // ObjectId instances. JS `Array.includes` uses `===`, which compares
    // object references and ALWAYS returns false for two different
    // ObjectId instances even when they represent the same id. Use
    // `.equals()` (Mongoose ObjectId / Document method) with a string
    // fallback for populated refs. Same pattern as `removeAgentFromPod`
    // below. Mirrors the bug the agent-room guard exposed: under the old
    // `.includes()` the host agent was treated as "not a member" of its
    // own room, the guard fired, and `null` propagated to callers as
    // "pod not found."
    const agentId = agentUser._id;
    const isAlreadyMember = pod.members.some((m: any) => (
      m && typeof m.equals === 'function'
        ? m.equals(agentId)
        : String(m) === String(agentId)
    ));

    if (!isAlreadyMember) {
      // DM pods are strictly 1:1 (ADR-001 §3.10): exactly two members,
      // human or agent. Auto-install paths MUST NOT sneak a third member
      // into an existing DM. A new conversation between a third party and
      // either of the two existing members spawns a NEW DM pod via
      // dmService.getOrCreateAgentDmRoom — never widens the existing one.
      // The same rule applies symmetrically to agent-room (1:1 user↔agent)
      // and agent-admin (1:1 admin↔agent).
      if (DM_POD_TYPES_GUARD.has(String(pod.type))) {
        console.warn(
          `[ensureAgentInPod] refused: pod ${pod._id} is type=${pod.type} (1:1 DM) `
          + `and ${agentId} is not already a member. ADR-001 §3.10.`,
        );
        return null;
      }
      pod.members.push(agentId);
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
