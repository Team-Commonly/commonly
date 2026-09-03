/**
 * agentStateService — #891 surface 1's derivation, kept pure.
 *
 * Answers, per agent install: can it actually respond to a mention right
 * now? States are PER RUNTIME CLASS because the #891 review measured
 * `lastUsedAt` lying for every class except the polling one:
 *
 *   - BYO wrapper/MCP installs (host 'byo' or legacy local-cli, no
 *     webhookUrl): the wrapper polls every ~5s while alive, so lastUsedAt is
 *     an honest reachability signal. null → never-connected · fresh →
 *     listening · stale → gone-dark.
 *   - push webhooks (webhookUrl set) and native runtime: reachable by
 *     construction — no dot, no guess.
 *   - everything else (gateway moltbots, cloud): 'unknown'. The gateway
 *     stamps one shared boot timestamp for a whole fleet (finding A);
 *     pretending to know is the false positive the ratified doc bans.
 *
 * Split key (decision 1): the state is the EXPLANATION and goes to any pod
 * viewer; `fixCommand` is an instruction and attaches only for the owner —
 * an instruction addressed to someone who cannot perform it is the P1/P2
 * contradiction the review caught.
 *
 * lastUsedAt is the max across BOTH token stores (User.agentRuntimeTokens
 * and AgentInstallation.runtimeTokens) — the legacy/new split that made
 * live agents read null (finding D). Pure function: callers fetch, this
 * derives; the seam is what makes the honesty rules testable without a DB.
 */

export const AGENT_LISTENING_STALE_MS = 5 * 60 * 1000;

export type AgentReachState = 'listening' | 'gone-dark' | 'never-connected' | 'reachable' | 'unknown';

interface TokenRow { lastUsedAt?: Date | string | null }

interface InstallationRow {
  agentName?: string;
  instanceId?: string;
  displayName?: string;
  installedBy?: unknown;
  config?: { runtime?: { runtimeType?: string; host?: string; webhookUrl?: string } };
  runtimeTokens?: TokenRow[];
}

export interface AgentStateRow {
  agentName: string;
  instanceId: string;
  displayName: string;
  state: AgentReachState;
  lastUsedAt: string | null;
  isOwner: boolean;
  fixCommand?: string;
}

const latestUse = (tokenLists: TokenRow[][]): Date | null => {
  let latest: Date | null = null;
  for (const list of tokenLists) {
    for (const row of list || []) {
      if (!row?.lastUsedAt) continue;
      const used = new Date(row.lastUsedAt as string);
      if (Number.isNaN(used.getTime())) continue;
      if (!latest || used > latest) latest = used;
    }
  }
  return latest;
};

export function deriveAgentState(
  installation: InstallationRow,
  userTokens: TokenRow[],
  callerId: string,
  now: number = Date.now(),
): AgentStateRow {
  const agentName = String(installation.agentName || '').toLowerCase();
  const instanceId = String(installation.instanceId || 'default');
  const runtime = installation.config?.runtime || {};
  const runtimeType = String(runtime.runtimeType || '').toLowerCase();
  const isByo = runtime.host === 'byo' || runtimeType === 'local-cli';
  const isPushWebhook = Boolean(runtime.webhookUrl);
  const isNative = runtimeType === 'native';

  let state: AgentReachState;
  let lastUsedAt: Date | null = null;
  if (isNative || isPushWebhook) {
    state = 'reachable';
  } else if (!isByo) {
    state = 'unknown';
  } else {
    lastUsedAt = latestUse([installation.runtimeTokens || [], userTokens || []]);
    if (!lastUsedAt) state = 'never-connected';
    else if (now - lastUsedAt.getTime() <= AGENT_LISTENING_STALE_MS) state = 'listening';
    else state = 'gone-dark';
  }

  const isOwner = String(installation.installedBy || '') === String(callerId || '');
  const needsFix = state === 'never-connected' || state === 'gone-dark';
  return {
    agentName,
    instanceId,
    displayName: installation.displayName || agentName,
    state,
    lastUsedAt: lastUsedAt ? lastUsedAt.toISOString() : null,
    isOwner,
    ...(isOwner && needsFix ? { fixCommand: `commonly agent run ${agentName}` } : {}),
  };
}

// ── activity buckets (Raft P4, added 2026-08-13) ────────────────────────────
// A SECOND derivation lives here deliberately, under a DIFFERENT name.
// `deriveAgentState` above answers "can a mention land right now?" (per
// runtime class, honesty-first). `deriveActivityBucket` below answers "when
// was this agent last alive, in coarse buckets?" for rosters and Scout's
// commonly_agent_status tool. The first version of this addition was
// written as a NEW FILE at this same path and silently clobbered the #891
// service AND its same-named test (the test that would have caught it) —
// every pod page crashed on the string payload (2026-08-13 live incident).
// Never add a "new" service without reading the path first; never name two
// exports the same thing because they feel similar.

const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // active within 10 minutes
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // stale after a silent day

// A recent liveness signal only proves that the runtime is alive. It does not
// prove that the seat produced a visible result for its human. Keep that
// distinction explicit on the roster: a live seat with no message in this
// window is *unverifiable*, not quietly productive.
export const OUTPUT_VERIFICATION_WINDOW_MS = 30 * 60 * 1000;
export type AgentOutputState = 'observed' | 'unverifiable' | 'quiet' | 'unknown';

const timestampOf = (value: Date | string | null | undefined): number | null => {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

/**
 * Distinguishes a recent runtime proof-of-life from a recent visible reply.
 *
 * `lastActiveAt` is deliberately not treated as output: it may come from a
 * heartbeat, runtime-token use, or AgentRun. Conversely, a persisted message
 * is direct proof that the agent did produce output, even if one of those
 * liveness collectors is behind. The caller owns the records; this pure seam
 * owns the 30-minute interpretation so roster consumers cannot drift.
 */
export const deriveAgentOutputState = (
  lastActiveAt: Date | string | null | undefined,
  lastMessageAt: Date | string | null | undefined,
  now: number = Date.now(),
): AgentOutputState => {
  const lastMessage = timestampOf(lastMessageAt);
  if (lastMessage !== null && now - lastMessage <= OUTPUT_VERIFICATION_WINDOW_MS) {
    return 'observed';
  }

  const lastActive = timestampOf(lastActiveAt);
  if (lastActive === null) return 'unknown';
  if (now - lastActive <= OUTPUT_VERIFICATION_WINDOW_MS) return 'unverifiable';
  return 'quiet';
};

export type AgentActivityBucket = 'active' | 'idle' | 'stale' | 'ready' | 'never-connected';

interface ActivityInstallationLike {
  agentName: string;
  instanceId?: string;
  config?: { runtime?: { runtimeType?: string } };
}

/**
 * Batch: max(last heartbeat, last run, last token use) per (agentName,
 * instanceId) for one pod — heartbeats cover gateway moltbots, AgentRuns
 * cover native agents, token lastUsedAt covers BYO/MCP wrappers. Shared by
 * the pod-agents roster route and commonly_agent_status.
 */
export const collectPodAgentActivity = async (
  podId: string,
  installations: ActivityInstallationLike[],
): Promise<Map<string, Date | null>> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mongoose = require('mongoose');
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
  // NAMED export — destructure, or the token source silently drops out of
  // the max (caught by the #915 regression suite).
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
 * Coarse activity vocabulary for rosters and Scout's status tool. `ready`
 * is the honest word for a native in-process agent with no runs yet — it
 * has no connection to make (#915 lesson).
 */
export const deriveActivityBucket = (
  lastActiveAt: Date | null | undefined,
  runtimeType?: string,
): AgentActivityBucket => {
  if (!lastActiveAt) {
    return runtimeType === 'native' ? 'ready' : 'never-connected';
  }
  const age = Date.now() - new Date(lastActiveAt).getTime();
  if (age <= ACTIVE_WINDOW_MS) return 'active';
  if (age <= STALE_AFTER_MS) return 'idle';
  return 'stale';
};

export default {
  deriveAgentState, AGENT_LISTENING_STALE_MS, collectPodAgentActivity, deriveActivityBucket,
  deriveAgentOutputState, OUTPUT_VERIFICATION_WINDOW_MS,
};
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
