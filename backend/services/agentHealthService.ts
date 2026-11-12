/**
 * Agent health (D115): per-install counts for the agents in the viewer's own
 * pods. Design: docs/architecture/fleet-health.md; frame:
 * docs/design/artboards/d115/.
 *
 * Three rules hold the shape of every query here:
 *  1. The pod set is the viewer's own memberships, `Pod.find({ members })`,
 *     with no admin bypass. Never DMService.canViewPod or listPodIdsForListing.
 *  2. The install set (`AgentInstallation` rows in those pods) filters every
 *     count before it is grouped, so another pod's agent never enters a result.
 *  3. Every read is an allowlist. Aggregations group only on enum fields, type
 *     and counts; payload, reason, errorMessage, details and turns never leave
 *     the database.
 */
import { classifyRuntime, AGENT_LISTENING_STALE_MS } from './agentStateService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentEvent = require('../models/AgentEvent');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentRun = require('../models/AgentRun');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentRuntimeObservation = require('../models/AgentRuntimeObservation');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');

const HOUR_MS = 60 * 60 * 1000;
export const WINDOW_OPTIONS_HOURS = [24, 72, 168] as const;
// The unmetered trigger, as nativeRuntimeService's daily cap leaves it out.
const UNMETERED_TRIGGER = 'first_contact';

export type WakeKind = 'mention' | 'heartbeat' | 'chat' | 'decision' | 'joined';
const KIND_BY_TYPE: Record<string, WakeKind> = {
  'chat.mention': 'mention',
  'thread.mention': 'mention',
  heartbeat: 'heartbeat',
  'message.posted': 'chat',
  'user.message': 'chat',
  'approval.resolved': 'decision',
  'decision.ruled': 'decision',
  'agent.ask': 'decision',
  first_contact: 'joined',
};

// Codes a person has to fix. Everything else counts as failed, not needs-you.
const BYO_NEEDS_YOU = new Set(['claude-signed-out', 'login', 'out-of-allowance', 'wont-start', 'codex-version']);
const HOSTED_NEEDS_YOU = new Set(['config']);

export type OutcomeBucket = 'posted' | 'declined' | 'failed' | 'expired' | 'acknowledged' | 'inFlight';
type Buckets = Record<OutcomeBucket, number> & { total: number };
const emptyBuckets = (): Buckets => ({
  total: 0, posted: 0, declined: 0, failed: 0, expired: 0, acknowledged: 0, inFlight: 0,
});

/**
 * One event group to one outcome. The order matters: a recorded outcome wins,
 * then a terminal status. Pending, folding and delivered with no outcome are in
 * flight, never failed (fleet-health.md, Outcomes).
 */
export function eventOutcome(status: string | null | undefined, outcome: string | null | undefined): OutcomeBucket {
  if (outcome === 'posted') return 'posted';
  if (outcome === 'no_action' || outcome === 'skipped') return 'declined';
  if (outcome === 'error' || status === 'failed') return 'failed';
  if (status === 'expired') return 'expired';
  if (outcome === 'acknowledged' || status === 'acked') return 'acknowledged';
  return 'inFlight';
}

export interface HealthWindow { hours: number; retentionHours: number; options: number[] }

/**
 * The default is 24 hours or the event retention, whichever is shorter, and an
 * option retention doesn't cover is never offered, so the page never counts a
 * span whose events were already deleted.
 */
export function resolveWindow(
  requested: unknown,
  retentionHours = Number(process.env.AGENT_EVENT_DELIVERED_RETENTION_HOURS || 168),
): HealthWindow {
  const retention = Math.max(1, Number.isFinite(retentionHours) ? Math.floor(retentionHours) : 168);
  const fallback = Math.min(24, retention);
  const offered = WINDOW_OPTIONS_HOURS.filter((h) => h <= retention);
  const options = Array.from(new Set([fallback, ...offered])).sort((a, b) => a - b);
  const match = typeof requested === 'string' ? /^(\d{1,3})h?$/.exec(requested.trim()) : null;
  const asked = match ? Number(match[1]) : NaN;
  return { hours: options.includes(asked) ? asked : fallback, retentionHours: retention, options };
}

const key = (agentName: string, instanceId: string | null | undefined, podId: unknown) => (
  `${String(agentName).toLowerCase()}\u0000${instanceId || 'default'}\u0000${String(podId)}`
);

export interface AgentHealthRow {
  agentName: string;
  instanceId: string;
  displayName: string;
  pod: { id: string; name: string; type: string };
  installStatus: string;
  runtime: 'hosted' | 'byo' | 'other';
  asked: Buckets;
  heartbeats: Buckets;
  digests: number;
  kinds: Record<WakeKind, number>;
  otherKinds: Record<string, number>;
  runs: null | {
    total: number; succeeded: number; failed: number; interrupted: number; inFlight: number;
    empty: number; meteredTurns: number; totalTokens: number; sandboxSeconds: number;
    errorKinds: Record<string, number>;
  };
  liveness: null | {
    lastSeenAt: string | null; online: boolean; turnRunning: boolean; lastSpawnFailure: string | null;
  };
  needsYou: string | null;
}

export interface AgentHealthResult { window: HealthWindow; generatedAt: string; agents: AgentHealthRow[] }

export async function readAgentHealth(
  viewerId: string,
  requestedWindow?: unknown,
  now = new Date(),
): Promise<AgentHealthResult> {
  const window = resolveWindow(requestedWindow);
  const since = new Date(now.getTime() - window.hours * HOUR_MS);
  const result: AgentHealthResult = { window, generatedAt: now.toISOString(), agents: [] };

  // 1. The viewer's own pods. Nothing wider, for a global admin too.
  const pods = await Pod.find({ members: viewerId }).select('_id name type').lean();
  if (!pods.length) return result;
  const podById = new Map<string, any>(pods.map((pod: any) => [String(pod._id), pod]));
  const podIds = pods.map((pod: any) => pod._id);

  // 2. The installs in those pods. `config` is read only to classify the
  // runtime and never leaves this function.
  const installs = await AgentInstallation.find({ podId: { $in: podIds }, status: { $ne: 'uninstalled' } })
    .select('agentName instanceId podId status displayName config')
    .lean();
  if (!installs.length) return result;

  const rows = new Map<string, AgentHealthRow>();
  for (const install of installs as any[]) {
    const pod = podById.get(String(install.podId));
    if (!pod) continue;
    const { isByo, isNative } = classifyRuntime(install);
    const runtime: AgentHealthRow['runtime'] = isByo ? 'byo' : (isNative ? 'hosted' : 'other');
    rows.set(key(install.agentName, install.instanceId, install.podId), {
      agentName: install.agentName,
      instanceId: install.instanceId || 'default',
      displayName: install.displayName || install.agentName,
      pod: { id: String(pod._id), name: pod.name || '', type: pod.type || '' },
      installStatus: install.status,
      runtime,
      asked: emptyBuckets(),
      heartbeats: emptyBuckets(),
      digests: 0,
      kinds: { mention: 0, heartbeat: 0, chat: 0, decision: 0, joined: 0 },
      otherKinds: {},
      runs: null,
      liveness: null,
      needsYou: null,
    });
  }
  const agentNames = Array.from(new Set((installs as any[]).map((install) => String(install.agentName).toLowerCase())));

  // 3. Events and runs, grouped on allowlisted keys only, then kept only when
  // the group's (agent, instance, pod) is an install in the viewer's pods.
  const [eventGroups, runGroups] = await Promise.all([
    AgentEvent.aggregate([
      { $match: { podId: { $in: podIds }, agentName: { $in: agentNames }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: {
            agentName: '$agentName', instanceId: '$instanceId', podId: '$podId',
            type: '$type', deliveryMode: '$deliveryMode', status: '$status', outcome: '$delivery.outcome',
          },
          n: { $sum: 1 },
        },
      },
    ]),
    AgentRun.aggregate([
      { $match: { podId: { $in: podIds }, agentName: { $in: agentNames }, startedAt: { $gte: since } } },
      {
        $group: {
          _id: {
            agentName: '$agentName', instanceId: '$instanceId', podId: '$podId',
            status: '$status', errorKind: '$errorKind', empty: { $eq: ['$emptyCompletion', true] },
            metered: { $and: [{ $ne: ['$metered', false] }, { $ne: ['$trigger', UNMETERED_TRIGGER] }] },
          },
          n: { $sum: 1 },
          tokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
          sandbox: { $sum: { $ifNull: ['$sandboxSeconds', 0] } },
        },
      },
    ]),
  ]);

  for (const group of eventGroups as any[]) {
    const id = group._id || {};
    const row = rows.get(key(id.agentName, id.instanceId, id.podId));
    if (!row) continue;
    const n = Number(group.n) || 0;
    if (id.deliveryMode === 'digest') { row.digests += n; continue; }
    const kind = KIND_BY_TYPE[String(id.type)];
    if (kind) row.kinds[kind] += n;
    else row.otherKinds[String(id.type)] = (row.otherKinds[String(id.type)] || 0) + n;
    const target = kind === 'heartbeat' ? row.heartbeats : row.asked;
    target[eventOutcome(id.status, id.outcome)] += n;
    target.total += n;
  }

  for (const group of runGroups as any[]) {
    const id = group._id || {};
    const row = rows.get(key(id.agentName, id.instanceId, id.podId));
    if (!row) continue;
    const n = Number(group.n) || 0;
    const runs = row.runs || (row.runs = {
      total: 0, succeeded: 0, failed: 0, interrupted: 0, inFlight: 0,
      empty: 0, meteredTurns: 0, totalTokens: 0, sandboxSeconds: 0, errorKinds: {},
    });
    runs.total += n;
    if (id.status === 'succeeded') runs.succeeded += n;
    else if (id.status === 'failed') runs.failed += n;
    else if (id.status === 'interrupted') runs.interrupted += n;
    else runs.inFlight += n;
    if (id.empty) runs.empty += n;
    if (id.metered) runs.meteredTurns += n;
    if (id.errorKind) runs.errorKinds[String(id.errorKind)] = (runs.errorKinds[String(id.errorKind)] || 0) + n;
    runs.totalTokens += Number(group.tokens) || 0;
    runs.sandboxSeconds += Number(group.sandbox) || 0;
  }

  // 4. Liveness for agents on someone's computer, joined through the agent's
  // User row. Only the fixed failure code is read, never free text.
  const byoRows = Array.from(rows.values()).filter((row) => row.runtime === 'byo');
  if (byoRows.length) {
    const bots = await User.find({
      isBot: true,
      $or: byoRows.map((row) => ({
        'botMetadata.agentName': row.agentName.toLowerCase(),
        'botMetadata.instanceId': row.instanceId,
      })),
    }).select('_id botMetadata.agentName botMetadata.instanceId').lean();
    const botIdByAgent = new Map<string, string>(bots.map((bot: any) => [
      `${String(bot.botMetadata?.agentName).toLowerCase()}\u0000${bot.botMetadata?.instanceId || 'default'}`,
      String(bot._id),
    ]));
    const botIds = bots.map((bot: any) => bot._id);
    const observations = bots.length ? await AgentRuntimeObservation.find({ agentUserId: { $in: botIds } })
      .select('agentUserId lastSeenAt turnRunning lastSpawnOutcome lastSpawnFailure -_id')
      .lean() : [];
    const observationByBot = new Map<string, any>(observations.map((o: any) => [String(o.agentUserId), o]));
    for (const row of byoRows) {
      const botId = botIdByAgent.get(`${row.agentName.toLowerCase()}\u0000${row.instanceId}`);
      const observation = botId ? observationByBot.get(botId) : null;
      const lastSeenAt = observation?.lastSeenAt ? new Date(observation.lastSeenAt) : null;
      const failure = observation?.lastSpawnOutcome === 'failed' ? (observation.lastSpawnFailure || null) : null;
      row.liveness = {
        lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
        online: Boolean(lastSeenAt && now.getTime() - lastSeenAt.getTime() <= AGENT_LISTENING_STALE_MS),
        turnRunning: Boolean(observation?.turnRunning),
        lastSpawnFailure: failure,
      };
      if (failure && BYO_NEEDS_YOU.has(failure)) row.needsYou = failure;
    }
  }
  for (const row of rows.values()) {
    if (row.runtime !== 'byo' && row.runs) {
      const code = Object.keys(row.runs.errorKinds).find((kind) => HOSTED_NEEDS_YOU.has(kind));
      if (code) row.needsYou = code;
    }
  }

  // Needs you first, then offline, then by asked wakes, most first.
  const rank = (row: AgentHealthRow) => (row.needsYou ? 0 : (row.liveness && !row.liveness.online ? 1 : 2));
  result.agents = Array.from(rows.values()).sort((a, b) => (
    rank(a) - rank(b) || b.asked.total - a.asked.total || a.displayName.localeCompare(b.displayName)
  ));
  return result;
}

export default { readAgentHealth, resolveWindow, eventOutcome };
