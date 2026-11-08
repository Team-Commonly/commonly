/**
 * May this agent identity run on Commonly's compute right now? The same rule
 * as the install and provision gate (an admin or the `cloudAgents`
 * entitlement), read while the agent runs.
 *
 * The account that counts is the installer of the identity's own rows: rows
 * on a runtime Commonly runs (isCloudRuntime) that are not projections
 * (`config.autoJoinSource`). An identity with only projections falls back to
 * its owner on record. The `internal` runtime, and the agent signup installs
 * in each person's name (authController's Scout), are Commonly's own and are
 * not read here; a hired copy of a first-party app is.
 *
 * Read by agentRuntimeAuth, the agent socket, the bot event feed and native
 * turns. Cached briefly per identity; clearCloudRuntimeCache drops it when an
 * entitlement or role changes.
 */
import { AgentInstallation } from '../models/AgentRegistry';
import User from '../models/User';
import AgentIdentityService, { isCloudRuntime } from './agentIdentityService';
import { installationIdentityFilter, IDENTITY_COLLATION } from './agentInstallationIdentity';
import { createHash } from 'crypto';
import { SIGNUP_INSTALLED_AGENT_NAMES } from '../config/native-agents/apps';

export const CLOUD_RUN_REFUSED_REASON = 'cloud_agents_not_entitled';

const CACHE_MS = 60 * 1000;
const CACHE_MAX = 5000;
const cache = new Map<string, { at: number; allowed: boolean }>();

const plain = (config: unknown): Record<string, unknown> => {
  if (!config) return {};
  if (config instanceof Map) return Object.fromEntries(config);
  return config as Record<string, unknown>;
};

type Row = { installedBy?: unknown; config?: unknown; agentName?: string; instanceId?: string };

/** The instance id signup gives a person's own agent (authController). */
const signupInstanceId = (userId: unknown): string => `u${createHash('sha256').update(String(userId)).digest('hex').slice(0, 10)}`;

/** The row signup wrote for this person, as opposed to one they installed or hired. */
const isSignupSeeded = (row: Row): boolean => Boolean(row.installedBy)
  && SIGNUP_INSTALLED_AGENT_NAMES.has(String(row.agentName || '').toLowerCase())
  && String(row.instanceId || '') === signupInstanceId(row.installedBy);

const ownerOnRecord = async (agentName: string, instanceId: string): Promise<unknown> => {
  const bot = await User.findOne({
    username: AgentIdentityService.buildAgentUsername(AgentIdentityService.resolveAgentType(agentName), instanceId),
    isBot: true,
  }).select('botMetadata.ownerUserId').lean() as { botMetadata?: { ownerUserId?: unknown } } | null;
  if (bot?.botMetadata?.ownerUserId) return bot.botMetadata.ownerUserId;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { AgentRegistry } = require('../models/AgentRegistry');
  const entry = await AgentRegistry.findOne({ agentName }).select('publisher.userId').lean();
  return entry?.publisher?.userId || null;
};

async function readMayRun(agentName: string, instanceId: string): Promise<boolean> {
  const typeRuntime = String(AgentIdentityService.getAgentTypeConfig(agentName)?.runtime || '').toLowerCase();
  const runtimeOf = (row: Row) => {
    const runtime = plain(plain(row.config).runtime) as { runtimeType?: string; host?: string };
    return { runtimeType: String(runtime.runtimeType || typeRuntime).toLowerCase(), host: runtime.host };
  };
  const rows = await AgentInstallation.find({
    ...installationIdentityFilter(agentName, instanceId),
    status: { $in: ['active', 'paused'] },
  }).collation(IDENTITY_COLLATION).select('installedBy config agentName instanceId').lean() as Row[];
  const cloudRows = rows.filter((row) => {
    const runtime = runtimeOf(row);
    return runtime.runtimeType !== 'internal' && isCloudRuntime(runtime) && !isSignupSeeded(row);
  });
  if (!cloudRows.length) return true;
  let ownerIds = cloudRows.filter((row) => !plain(row.config).autoJoinSource).map((row) => row.installedBy);
  if (!ownerIds.length) ownerIds = [await ownerOnRecord(agentName, instanceId)];
  const ids = Array.from(new Set(ownerIds.filter(Boolean).map(String)));
  // A row with no installer, or no owner on record, predates installers.
  if (!ids.length || ownerIds.some((id) => !id)) return true;
  const users = await User.find({ _id: { $in: ids } })
    .select('_id role isBot entitlements').lean() as Array<{
      role?: string; isBot?: boolean; entitlements?: { cloudAgents?: boolean };
    }>;
  // Account deletion uninstalls a person's rows, so an installer with no User
  // row is legacy data.
  if (users.length < ids.length) return true;
  return users.some((user) => user.role === 'admin' || user.isBot === true || user.entitlements?.cloudAgents === true);
}

export async function cloudRuntimeMayRun(agentName: string, instanceId = 'default'): Promise<boolean> {
  const name = String(agentName || '').trim().toLowerCase();
  const instance = String(instanceId || 'default');
  if (!name) return true;
  const key = `${name}:${instance.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.allowed;
  let allowed: boolean;
  try {
    allowed = await readMayRun(name, instance);
  } catch (error) {
    // Toward running, uncached: a read outage must not stop every agent.
    console.warn('[cloud-runtime] ownership read failed; letting it run:', (error as Error).message);
    return true;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { at: Date.now(), allowed });
  return allowed;
}

export function clearCloudRuntimeCache(): void {
  cache.clear();
}
