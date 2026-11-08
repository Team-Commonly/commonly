/**
 * May this agent identity run on Commonly's compute right now?
 *
 * Installing or provisioning a cloud runtime (CLOUD_RUNTIME_TYPES, or codex
 * without `host: 'byo'`) needs an admin or the `cloudAgents` entitlement. This
 * is the same rule at run time, so an account that loses the entitlement, or
 * an admin role, stops running the cloud agents it already installed.
 *
 * The account that counts is the installer of the identity's own rows: rows
 * that name a cloud runtime in `config.runtime` and are not projections. A
 * projection (`config.autoJoinSource`: a DM room, an agent-dm, an auto-join)
 * names whoever opened it as installer, not whoever runs the agent, so it
 * never decides. A first-party auto-install that names no runtime isn't gated.
 * A bot installer is a system path, and a row with no installer, or one
 * whose installer has no User row, is legacy; none of them is refused.
 *
 * The identity may run when it has no such row, or when any such row's
 * installer is an admin, a bot, or entitled. Cached briefly per identity, so
 * a revocation takes effect within CACHE_MS.
 */
import { AgentInstallation } from '../models/AgentRegistry';
import User from '../models/User';
import { isCloudRuntime } from './agentIdentityService';

export const CLOUD_RUN_REFUSED_REASON = 'cloud_agents_not_entitled';

const CACHE_MS = 60 * 1000;
const cache = new Map<string, { at: number; allowed: boolean }>();

const plain = (config: unknown): Record<string, unknown> => {
  if (!config) return {};
  if (config instanceof Map) return Object.fromEntries(config);
  return config as Record<string, unknown>;
};

const ownsCloudRuntime = (row: { config?: unknown }): boolean => {
  const config = plain(row.config);
  if (config.autoJoinSource) return false;
  const runtime = plain(config.runtime) as { runtimeType?: string; host?: string };
  return Boolean(runtime.runtimeType) && isCloudRuntime(runtime);
};

export async function cloudRuntimeMayRun(agentName: string, instanceId = 'default'): Promise<boolean> {
  const key = `${String(agentName || '').toLowerCase()}:${instanceId || 'default'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.allowed;
  let allowed: boolean;
  try {
    allowed = await readMayRun(agentName, instanceId);
  } catch (error) {
    // Toward running, uncached: a read outage must not stop every native agent.
    console.warn('[cloud-runtime] ownership read failed; letting the turn run:', (error as Error).message);
    return true;
  }
  cache.set(key, { at: Date.now(), allowed });
  return allowed;
}

async function readMayRun(agentName: string, instanceId: string): Promise<boolean> {
  const rows = await AgentInstallation.find({
    agentName: String(agentName || '').toLowerCase(),
    instanceId: instanceId || 'default',
    status: { $in: ['active', 'paused'] },
    'config.runtime.runtimeType': { $exists: true },
  }).select('installedBy config').lean() as Array<{ installedBy?: unknown; config?: unknown }>;
  const owners = rows.filter(ownsCloudRuntime);
  let allowed = owners.length === 0 || owners.some((row) => !row.installedBy);
  if (!allowed) {
    const users = await User.find({ _id: { $in: owners.map((row) => row.installedBy) } })
      .select('_id role isBot entitlements').lean() as Array<{
        role?: string; isBot?: boolean; entitlements?: { cloudAgents?: boolean };
      }>;
    // An installer with no User row is legacy data (account deletion
    // uninstalls a person's rows), so it doesn't gate either.
    allowed = users.length < new Set(owners.map((row) => String(row.installedBy))).size
      || users.some((user) => user.role === 'admin' || user.isBot === true || user.entitlements?.cloudAgents === true);
  }
  return allowed;
}

/** For tests, and for a caller that has just changed an entitlement. */
export function clearCloudRuntimeCache(): void {
  cache.clear();
}
