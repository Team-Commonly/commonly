/**
 * agentStateService — #891 surface 1's derivation, kept pure.
 *
 * Answers, per agent install: can it actually respond to a mention right
 * now? States are PER RUNTIME CLASS because the #891 review measured
 * `lastUsedAt` lying for every class except the polling one:
 *
 *   - BYO wrapper/MCP installs (host 'byo' or legacy local-cli, no
 *     webhookUrl): the wrapper polls every ~5s while alive, so the last
 *     LISTENER check-in (`lastListenedAt`, stamped by the events poll, the
 *     WebSocket connect and a delivery renew) is an honest reachability signal. null →
 *     never-connected · fresh → listening · stale → gone-dark. `lastUsedAt`
 *     is not: any authenticated call stamps it, so one MCP tool call made a
 *     seat nobody was running read as listening (TASK-719, TASK-721).
 *   - native runtime: reachable by construction — no dot, no guess.
 *   - push webhooks (webhookUrl set): measured by the last delivery to the
 *     URL now registered. Its endpoint answered → reachable · it failed after
 *     the last answer → gone-dark, carrying the failure's kind · nothing sent
 *     to this URL yet → unknown. These were reachable by construction until
 *     a dead URL read as live in every pod. See docs/agents/push-webhook-status.md.
 *   - everything else (gateway moltbots, cloud): 'unknown'. The gateway
 *     stamps one shared boot timestamp for a whole fleet (finding A);
 *     pretending to know is the false positive the ratified doc bans.
 *
 * Split key (decision 1): the state is the EXPLANATION and goes to any pod
 * viewer; `fixCommand` is an instruction and attaches only for the owner —
 * an instruction addressed to someone who cannot perform it is the P1/P2
 * contradiction the review caught.
 *
 * The check-in time is the max across BOTH token stores
 * (User.agentRuntimeTokens and AgentInstallation.runtimeTokens) — the
 * legacy/new split that made live agents read null (finding D). Pure function: callers fetch, this
 * derives; the seam is what makes the honesty rules testable without a DB.
 */
import crypto from 'crypto';
import { hostedRunsNative } from './hostedEngine';
import { BYO_STALE_MS } from './agentConnectionStateService';
import { newestPerInstall } from './newestPerInstall';

export const AGENT_LISTENING_STALE_MS = 5 * 60 * 1000;

export type AgentReachState = 'listening' | 'gone-dark' | 'never-connected' | 'reachable' | 'unknown';

interface TokenRow { lastUsedAt?: Date | string | null; lastListenedAt?: Date | string | null }

interface WebhookDeliveryRow {
  urlHash?: string;
  lastAttemptAt?: Date | string | null;
  lastOkAt?: Date | string | null;
  lastFailedAt?: Date | string | null;
  lastFailure?: string;
  lastFailureStatus?: number;
}

/** Keys a recorded delivery to the URL it went to, without storing the URL. */
export const webhookUrlHash = (url: string): string => crypto.createHash('sha256')
  .update(String(url)).digest('hex').slice(0, 32);

export interface WebhookDeliveryError {
  at: string;
  kind: 'http' | 'timeout' | 'network' | 'refused';
  status?: number;
}

interface InstallationRow {
  agentName?: string;
  instanceId?: string;
  displayName?: string;
  installedBy?: unknown;
  config?: { runtime?: { runtimeType?: string; host?: string; adapter?: string; webhookUrl?: string } };
  runtimeTokens?: TokenRow[];
  webhookDelivery?: WebhookDeliveryRow | null;
}

export interface AgentStateRow {
  agentName: string;
  instanceId: string;
  displayName: string;
  state: AgentReachState;
  /**
   * For a polling BYO seat, the last LISTENER check-in, not the last token use.
   * The key keeps its old name because the shell reads it (V2Thread "last seen").
   */
  lastUsedAt: string | null;
  isOwner: boolean;
  /** A Commonly-hosted agent ("Run it here"); the beta allows one per account. */
  hosted: boolean;
  fixCommand?: string;
  /**
   * F515: why a never-connected agent's first run stopped before it started
   * waiting, as a code the run reported (never text from that computer).
   */
  listenReason?: ListenReason;
  /**
   * The pod Bring your own can hand this agent a key in. In an agent room it's
   * another pod: the room's install is a copy, and that page refuses a DM pod.
   */
  connectPodId?: string;
  /** Made on the page, so no computer has its key and the bare command can't start it. */
  noSavedKey?: boolean;
  /** A push webhook whose last delivery failed: what failed and when. No URL, no error text. */
  deliveryError?: WebhookDeliveryError;
}

const latestListen = (tokenLists: TokenRow[][]): Date | null => {
  let latest: Date | null = null;
  for (const list of tokenLists) {
    for (const row of list || []) {
      if (!row?.lastListenedAt) continue;
      const used = new Date(row.lastListenedAt as string);
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

// The CLI's own rule for an instance id (cli `agent run --instance-id`), which
// becomes part of a file name there and of a pasted command here.
const INSTANCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// What to tell an owner who must make an agent run. `commonly agent run` only
// starts a polling BYO wrapper. A push webhook runs the owner's own endpoint,
// and a native or hosted seat runs on Commonly, so neither gets that command.
// A second instance holds its own key, so its command names the instance: the
// name alone starts the default one. Null means there is no instruction to give.
export function runInstructionFor(installation: InstallationRow): string | null {
  const { isByo, isPushWebhook } = classifyRuntime(installation);
  // A webhook URL wins over a host stamp: an install stamped host 'byo' that
  // pushes to a URL has no wrapper for `commonly agent run` to start.
  if (isPushWebhook) return WEBHOOK_RUN_INSTRUCTION;
  if (!isByo) return null;
  const command = `commonly agent run ${String(installation.agentName || '').toLowerCase()}`;
  const instanceId = String(installation.instanceId || 'default');
  return instanceId.toLowerCase() !== 'default' && INSTANCE_ID_RE.test(instanceId)
    ? `${command} --instance-id ${instanceId}` : command;
}

// Whether Bring your own's Connect can help a never-connected agent. It can't
// for a wrapper, which Reconnect refuses unless it was bound to a computer, or
// for a seat on a machine, which starts from that machine. A second instance
// can: the Connect link carries its instanceId, and the page installs and
// issues the key for that instance, with `--instance-id` in the command.
export function offersConnect(installation: InstallationRow, machineId?: unknown): boolean {
  const runtimeType = String(installation.config?.runtime?.runtimeType || '').toLowerCase();
  return classifyRuntime(installation).isByo
    && runtimeType !== 'wrapper'
    && !machineId;
}

// Made on the Bring your own page: its key went out once, in the connect
// command, so no computer has it saved. `commonly agent attach` and `agent init`
// each save one, and neither writes this shape: attach names the real runtime,
// and init sets no adapter. Both keep their bare command, because Connect would
// revoke the saved key.
export function keyOnlyOnPage(installation: InstallationRow, machineId?: unknown): boolean {
  const runtime = installation.config?.runtime;
  return offersConnect(installation, machineId)
    && String(runtime?.runtimeType || '').toLowerCase() === 'webhook'
    && String(runtime?.host || '').toLowerCase() === 'byo'
    && Boolean(runtime?.adapter)
    && !runtime?.webhookUrl;
}

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
};

const FAILURE_KINDS = new Set(['http', 'timeout', 'network', 'refused']);

// A push webhook's reach, from the last delivery to the URL registered now.
// A record for another URL says nothing about this one.
function webhookReach(installation: InstallationRow): {
  state: AgentReachState; lastUsedAt: Date | null; deliveryError?: WebhookDeliveryError;
} {
  const url = String(installation.config?.runtime?.webhookUrl || '');
  const record = installation.webhookDelivery;
  if (!record || record.urlHash !== webhookUrlHash(url)) return { state: 'unknown', lastUsedAt: null };
  const okAt = toDate(record.lastOkAt);
  const failedAt = toDate(record.lastFailedAt);
  if (failedAt && (!okAt || failedAt > okAt)) {
    const kind = FAILURE_KINDS.has(String(record.lastFailure))
      ? record.lastFailure as WebhookDeliveryError['kind'] : 'network';
    return {
      state: 'gone-dark',
      lastUsedAt: okAt,
      deliveryError: {
        at: failedAt.toISOString(),
        kind,
        ...(kind === 'http' && typeof record.lastFailureStatus === 'number'
          ? { status: record.lastFailureStatus } : {}),
      },
    };
  }
  if (okAt) return { state: 'reachable', lastUsedAt: okAt };
  return { state: 'unknown', lastUsedAt: null };
}

export interface ListenReason {
  reason: 'harness-missing' | 'harness-signed-out' | 'node-too-old';
  harness: string | null;
}

/**
 * F515: the newest report a first run made before it stopped (no harness, a
 * signed-out one, or an old Node), or null. Only for an agent with no listen
 * yet: a check-in supersedes every report, and a row that has listened has no
 * use for one.
 */
export function listenReasonFor(botMetadata: any): ListenReason | null {
  const at = (value: unknown) => {
    const date = value ? new Date(value as string | number | Date) : null;
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
  };
  const harnessOf = (value: unknown) => (typeof value === 'string' ? value : null);
  const reports: Array<{ at: number; reason: ListenReason }> = [];
  const missing = botMetadata?.harnessMissing;
  const missingAt = at(missing?.at);
  if (missingAt !== null) {
    reports.push({ at: missingAt, reason: { reason: 'harness-missing', harness: harnessOf(missing.harness) } });
  }
  const blocked = botMetadata?.listenBlocked;
  const blockedAt = at(blocked?.at);
  if (blockedAt !== null && (blocked.reason === 'harness-signed-out' || blocked.reason === 'node-too-old')) {
    reports.push({ at: blockedAt, reason: { reason: blocked.reason, harness: harnessOf(blocked.harness) } });
  }
  if (!reports.length) return null;
  return reports.sort((a, b) => b.at - a.at)[0].reason;
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
  let deliveryError: WebhookDeliveryError | undefined;
  if (isNative) {
    state = 'reachable';
  } else if (isPushWebhook) {
    ({ state, lastUsedAt, deliveryError } = webhookReach(installation));
  } else if (!isByo) {
    state = 'unknown';
  } else {
    lastUsedAt = latestListen([installation.runtimeTokens || [], userTokens || []]);
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
    ...(deliveryError ? { deliveryError } : {}),
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

// The same five minutes as the roster and Settings connection verdict
// (agentConnectionStateService), so Scout and the page never disagree about
// an agent that checked in seven minutes ago.
const ACTIVE_WINDOW_MS = BYO_STALE_MS;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // stale after a silent day

export type AgentActivityBucket = 'active' | 'idle' | 'stale' | 'ready' | 'never-connected';

interface ActivityInstallationLike {
  agentName: string;
  instanceId?: string;
  config?: { runtime?: { runtimeType?: string } };
  runtimeTokens?: Array<{ lastUsedAt?: Date | null }>;
}

/**
 * Newest delivered heartbeat per install, keyed `agentName:instanceId`
 * (TASK-774: one index seek per install, not a read of the seat's events).
 */
export const lastHeartbeatPerInstall = (
  installations: ActivityInstallationLike[],
): Promise<Map<string, Date>> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AgentEvent = require('../models/AgentEvent');
  return newestPerInstall(AgentEvent, installations, {
    match: ({ agentName, instanceId }) => ({ agentName, instanceId, type: 'heartbeat', status: 'delivered' }),
    field: 'createdAt',
  });
};

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

  const heartbeatMap = await lastHeartbeatPerInstall(installations);

  // Native agents never heartbeat and never use a runtime token — their
  // proof of life is AgentRun rows. Aggregation $match does not cast, so
  // podId must be an ObjectId (#915). One seek per install on
  // { podId, agentName, instanceId, startedAt }; a run with no instanceId
  // (missing, null or '') counts for `default`, as it always has.
  let runMap = new Map<string, Date>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AgentRun = require('../models/AgentRun');
    const pod = new mongoose.Types.ObjectId(String(podId));
    runMap = await newestPerInstall(AgentRun, installations, {
      match: ({ agentName, instanceId }) => ({
        podId: pod,
        agentName,
        instanceId: instanceId === 'default' ? { $in: ['default', null, ''] } : instanceId,
      }),
      field: 'startedAt',
    });
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
