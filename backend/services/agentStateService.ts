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
import { hostedRunsNative } from './hostedEngine';

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
  /** A Commonly-hosted agent ("Run it here"); the beta allows one per account. */
  hosted: boolean;
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

// One classification for both the liveness derivation and the run instruction,
// so the two cannot disagree about what kind of seat this is.
export function classifyRuntime(installation: InstallationRow): {
  isNative: boolean; isPushWebhook: boolean; isByo: boolean;
} {
  const runtime = installation.config?.runtime || {};
  const runtimeType = String(runtime.runtimeType || '').toLowerCase();
  const isPushWebhook = Boolean(runtime.webhookUrl);
  // Older self-serve and approval-created polling seats were stored as
  // webhook without a host stamp. The install route already treats this
  // shape as BYO; classify existing rows the same way for liveness.
  const isByo = runtime.host === 'byo'
    || runtimeType === 'local-cli'
    || (runtimeType === 'webhook' && !runtime.host && !isPushWebhook);
  // A provisioned hosted install on the native engine has no connection to
  // make either (services/hostedEngine.ts).
  const isNative = runtimeType === 'native' || hostedRunsNative(installation);
  return { isNative, isPushWebhook, isByo };
}

export const WEBHOOK_RUN_INSTRUCTION = 'Run the program behind your webhook URL. '
  + 'A webhook agent has no `commonly` run command; see docs/agents/WEBHOOK_SDK.md.';

// What to tell an owner who must make an agent run. `commonly agent run` only
// starts a polling BYO wrapper. A push webhook runs the owner's own endpoint,
// and a native or hosted seat runs on Commonly, so neither gets that command.
// Null means there is no instruction to give.
export function runInstructionFor(installation: InstallationRow): string | null {
  const { isByo, isPushWebhook } = classifyRuntime(installation);
  if (isByo) return `commonly agent run ${String(installation.agentName || '').toLowerCase()}`;
  if (isPushWebhook) return WEBHOOK_RUN_INSTRUCTION;
  return null;
}

export function deriveAgentState(
  installation: InstallationRow,
  userTokens: TokenRow[],
  callerId: string,
  now: number = Date.now(),
): AgentStateRow {
  const agentName = String(installation.agentName || '').toLowerCase();
  const instanceId = String(installation.instanceId || 'default');
  const { isNative, isPushWebhook, isByo } = classifyRuntime(installation);
  const runtimeType = String(installation.config?.runtime?.runtimeType || '').toLowerCase();

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
    // The shell hides Scout's "Run it here" start once the viewer holds one.
    hosted: runtimeType === 'hosted',
    ...(isOwner && needsFix && runInstructionFor(installation)
      ? { fixCommand: runInstructionFor(installation) as string } : {}),
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

export type AgentActivityBucket = 'active' | 'idle' | 'stale' | 'ready' | 'never-connected';

interface ActivityInstallationLike {
  agentName: string;
  instanceId?: string;
  config?: { runtime?: { runtimeType?: string } };
  runtimeTokens?: Array<{ lastUsedAt?: Date | null }>;
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
      .select('_id username agentRuntimeTokens.lastUsedAt')
      .lean()
    : [];
  const userByUsername = new Map<string, { _id?: unknown; agentRuntimeTokens?: Array<{ lastUsedAt?: Date }> }>(
    (userRows as Array<{ username: string }>).map((u) => [u.username, u as never]),
  );

  // A seat's key can also live in the credential ledger (connect page,
  // daemon mints, spawn children) or on a legacy installation. Runtime auth
  // stamps lastUsedAt on whichever store authenticated the call, so the
  // status read has to take all three.
  // A failed ledger read throws rather than reading as "never connected":
  // the status tool turns it into a failed call, and the roster route keeps
  // its advisory fallback.
  const credentialTimeByUser = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AgentCredential = require('../models/AgentCredential');
  const agentUserIds = (userRows as Array<{ _id?: unknown }>).map((u) => u._id).filter(Boolean);
  const credentials = agentUserIds.length > 0
    ? await AgentCredential.find({ kind: 'runtime', agentUserId: { $in: agentUserIds } })
      .select('agentUserId lastUsedAt')
      .lean()
    : [];
  for (const credential of credentials as Array<{ agentUserId?: unknown; lastUsedAt?: Date | null }>) {
    const time = credential.lastUsedAt ? new Date(credential.lastUsedAt).getTime() : 0;
    const id = String(credential.agentUserId);
    if (time > (credentialTimeByUser.get(id) || 0)) credentialTimeByUser.set(id, time);
  }

  for (const i of installations) {
    const k = key(i.agentName, i.instanceId);
    const user = userByUsername.get(usernameByKey.get(k) || '');
    const tokenTimes = [...(user?.agentRuntimeTokens || []), ...(i.runtimeTokens || [])]
      .map((tok) => (tok?.lastUsedAt ? new Date(tok.lastUsedAt).getTime() : 0));
    const credentialTime = user?._id ? credentialTimeByUser.get(String(user._id)) : undefined;
    const candidates = [heartbeatMap.get(k), runMap.get(k), ...tokenTimes, credentialTime]
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
};
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
