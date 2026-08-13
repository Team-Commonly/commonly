/**
 * agentStateService — the ONE derivation of "is this agent alive?".
 *
 * Proof of life comes from three sources, each covering a runtime class the
 * others miss: heartbeat AgentEvents (gateway moltbots), runtime-token
 * lastUsedAt (BYO wrappers / MCP seats), AgentRun rows (native in-process
 * agents). The pod-agents roster route and the native runtime's
 * commonly_agent_status tool both call THIS module — the Raft comparison
 * (P4, 2026-08-12) flagged that we derive status in multiple places with
 * different vocabulary; this is the consolidation point. Do not fork the
 * bucket thresholds into a surface-local copy.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mongoose = require('mongoose');

const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // active within 10 minutes
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // stale after a silent day

export type AgentStateBucket = 'active' | 'idle' | 'stale' | 'ready' | 'never-connected';

interface InstallationLike {
  agentName: string;
  instanceId?: string;
  config?: { runtime?: { runtimeType?: string } };
}

/**
 * Batch: max(last heartbeat, last run, last token use) per (agentName,
 * instanceId) for one pod. Extracted verbatim from the pod-agents route so
 * the route and the tool cannot drift. Advisory by contract — throws are the
 * caller's to soften; each internal source degrades to "no signal".
 */
export const collectPodAgentActivity = async (
  podId: string,
  installations: InstallationLike[],
): Promise<Map<string, Date | null>> => {
  const key = (agentName: string, instanceId?: string) => `${agentName}:${instanceId || 'default'}`;
  const result = new Map<string, Date | null>();
  if (!installations.length) return result;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AgentEvent = require('../models/AgentEvent');
  const heartbeatRows = await AgentEvent.aggregate([
    {
      $match: {
        type: 'heartbeat',
        status: 'delivered',
        agentName: { $in: installations.map((i) => i.agentName) },
        instanceId: { $in: installations.map((i) => i.instanceId || 'default') },
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: { agentName: '$agentName', instanceId: '$instanceId' },
        lastHeartbeatAt: { $first: '$createdAt' },
      },
    },
  ]);
  const heartbeatMap = new Map<string, Date>(
    heartbeatRows.map((r: { _id: { agentName: string; instanceId: string }; lastHeartbeatAt: Date }) => [
      key(r._id.agentName, r._id.instanceId), r.lastHeartbeatAt,
    ]),
  );

  // Native agents never heartbeat and never use a runtime token — their
  // proof of life is AgentRun rows. Aggregation $match does not cast, so
  // podId must be an ObjectId (#915).
  let runMap = new Map<string, Date>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AgentRun = require('../models/AgentRun');
    const runRows = await AgentRun.aggregate([
      {
        $match: {
          podId: new mongoose.Types.ObjectId(String(podId)),
          agentName: { $in: installations.map((i) => i.agentName) },
        },
      },
      { $sort: { startedAt: -1 } },
      {
        $group: {
          _id: { agentName: '$agentName', instanceId: '$instanceId' },
          lastRunAt: { $first: '$startedAt' },
        },
      },
    ]);
    runMap = new Map(
      runRows.map((r: { _id: { agentName: string; instanceId?: string }; lastRunAt: Date }) => [
        key(r._id.agentName, r._id.instanceId), r.lastRunAt,
      ]),
    );
  } catch (runErr) {
    console.warn('[agent-state] AgentRun activity lookup failed:', (runErr as Error).message);
  }

  // Token lastUsedAt lives on the bot User rows. buildAgentUsername is a
  // NAMED export (not a static on the default service class) — destructure,
  // or the token source silently drops out of the max (caught by the #915
  // regression suite during extraction).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildAgentUsername } = require('./agentIdentityService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const User = require('../models/User');
  const usernameByKey = new Map<string, string>();
  for (const i of installations) {
    const username = typeof buildAgentUsername === 'function'
      ? buildAgentUsername(i.agentName, i.instanceId || 'default')
      : null;
    if (username) usernameByKey.set(key(i.agentName, i.instanceId), username);
  }
  const userRows = usernameByKey.size > 0
    ? await User.find({ username: { $in: Array.from(usernameByKey.values()) } })
      .select('username agentRuntimeTokens.lastUsedAt')
      .lean()
    : [];
  const userByUsername = new Map<string, { agentRuntimeTokens?: Array<{ lastUsedAt?: Date }> }>(
    (userRows as Array<{ username: string }>).map((u) => [u.username, u as never]),
  );

  for (const i of installations) {
    const k = key(i.agentName, i.instanceId);
    const user = userByUsername.get(usernameByKey.get(k) || '');
    const tokenTimes = (user?.agentRuntimeTokens || [])
      .map((tok) => (tok?.lastUsedAt ? new Date(tok.lastUsedAt).getTime() : 0));
    const candidates = [heartbeatMap.get(k), runMap.get(k), ...tokenTimes]
      .map((v) => (v ? new Date(v as Date).getTime() : 0))
      .filter((v) => Number.isFinite(v) && v > 0);
    result.set(k, candidates.length > 0 ? new Date(Math.max(...candidates)) : null);
  }
  return result;
};

/**
 * The bucket vocabulary every surface speaks. `ready` is the honest word for
 * a native in-process agent with no runs yet — it has no connection to make,
 * it runs when addressed; calling it "never connected" (#915's bug) taught
 * users a false model.
 */
export const deriveAgentState = (
  lastActiveAt: Date | null | undefined,
  runtimeType?: string,
): AgentStateBucket => {
  if (!lastActiveAt) {
    return runtimeType === 'native' ? 'ready' : 'never-connected';
  }
  const age = Date.now() - new Date(lastActiveAt).getTime();
  if (age <= ACTIVE_WINDOW_MS) return 'active';
  if (age <= STALE_AFTER_MS) return 'idle';
  return 'stale';
};

export default { collectPodAgentActivity, deriveAgentState };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
