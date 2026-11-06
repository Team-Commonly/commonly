/**
 * Hosted runtime (ADR-023 W2) — the kernel-side half of "Run it here".
 *
 * The runtime itself is `workers/agent-runtime` (one Durable Object per
 * agent, polling CAP with a runtime token). This service is the only place
 * the backend talks to it, and the only place hosted METERING lives. ADR-023
 * D3.1 is explicit that a per-user provision surface ships together with
 * metering; the two caps below are that floor — not billing, the thing that
 * makes an unmetered public runtime safe to expose:
 *
 *   HOSTED_AGENTS_PER_USER  hosted agents per owner (default 1). An agent is
 *                           one (agentName, instanceId): it has an active row
 *                           per room, and more rooms are not more agents.
 *   HOSTED_TURNS_PER_DAY    acked events per hosted agent per UTC day (30;
 *                           HOSTED_TURNS_PER_DAY_PRO, 200, on Pro)
 *
 * The daily cap is a RATE LIMIT ON REQUESTS, not a spend meter: it counts
 * acked AgentEvents by ack time (`deliveredAt`, which ack() stamps). One
 * acked event is up to the worker's tool budget in model calls, and a turn
 * that fails every retry is never acked — metered zero. Good enough as the
 * D3.1 beta floor; charging against credits needs the worker's own counts.
 * Counting by ack time rather than createdAt matters at the UTC boundary:
 * an event created 23:59 and acked 00:01 must land in today's bucket, or
 * anything queued across midnight is free.
 * When the daily cap is reached the events feed returns empty for that agent
 * BEFORE list() claims anything (see agentsRuntime GET /events), so capped
 * events stay pending and un-attempted; GC only touches 'delivered' rows.
 *
 * Configuration: HOSTED_RUNTIME_URL + HOSTED_RUNTIME_ADMIN_TOKEN. Unset means
 * the surface reports 503 `hosted_runtime_unconfigured` — never a silent
 * fallback to a different runtime.
 */
import { AgentInstallation } from '../models/AgentRegistry';
import AgentEvent from '../models/AgentEvent';
import { installationIdentityFilter } from './agentInstallationIdentity';

export const HOSTED_RUNTIME_TYPE = 'hosted';

const DEFAULT_AGENTS_PER_USER = 1;
// The plan line (TASK-268, ruled 2026-10-15): hosted turns a day per agent.
const DEFAULT_TURNS_PER_DAY = 30;
const DEFAULT_TURNS_PER_DAY_PRO = 200;
const WORKER_TIMEOUT_MS = 10_000;

const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * The hosted caps for a plan: 30 turns a day free, 200 on pro. Pro is
 * `entitlements.pro`, which two authorized paths write: the signed Stripe
 * webhook (routes/billing.ts) and an instance admin's entitlements PATCH
 * (routes/admin/users.ts, how pilots and design partners get Pro). No client
 * field sets it. Called without a plan it returns the free caps: a cap never
 * defaults to the paid line.
 */
export const hostedCaps = ({ pro = false }: { pro?: boolean } = {}) => ({
  agentsPerUser: intEnv('HOSTED_AGENTS_PER_USER', DEFAULT_AGENTS_PER_USER),
  turnsPerDay: pro
    ? intEnv('HOSTED_TURNS_PER_DAY_PRO', DEFAULT_TURNS_PER_DAY_PRO)
    : intEnv('HOSTED_TURNS_PER_DAY', DEFAULT_TURNS_PER_DAY),
});

/** Whether a user is on pro. A missing user or a failed lookup reads as free. */
export const ownerIsPro = async (userId: unknown): Promise<boolean> => {
  const id = String(userId ?? '');
  if (!/^[a-f\d]{24}$/i.test(id)) return false;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const User = require('../models/User');
    const user = await User.findById(id).select('entitlements.pro').lean();
    return user?.entitlements?.pro === true;
  } catch (error) {
    console.warn('[hosted] plan lookup failed; using the free caps:', (error as Error).message);
    return false;
  }
};

/** The hosted caps for whoever owns (installed) a hosted agent. */
export const hostedCapsForOwner = async (userId: unknown) => hostedCaps({ pro: await ownerIsPro(userId) });

/** The native per-user daily run ceiling; null means the guard is disabled. */
export const userRunCeilingForOwner = async (userId: unknown): Promise<number | null> => {
  const free = Number(process.env.AGENT_USER_DAILY_RUN_CEILING ?? 120);
  if (!Number.isFinite(free) || free <= 0) return null;
  const pro = Number(process.env.AGENT_USER_DAILY_RUN_CEILING_PRO ?? 300);
  return (await ownerIsPro(userId)) && Number.isFinite(pro) && pro > 0 ? pro : free;
};

export const hostedRuntimeConfig = () => ({
  url: String(process.env.HOSTED_RUNTIME_URL || '').trim().replace(/\/+$/, ''),
  adminToken: String(process.env.HOSTED_RUNTIME_ADMIN_TOKEN || '').trim(),
});

export const isConfigured = (): boolean => {
  const { url, adminToken } = hostedRuntimeConfig();
  return Boolean(url && adminToken);
};

/**
 * `AgentInstallation.config` is a Mongoose Map of Mixed, so the runtime block
 * is reached with `.get('runtime')` on a hydrated doc and as a plain property
 * on a `.lean()` row. Accept both — every caller that forgot the Map shape so
 * far read `undefined` and reported success (see the Map-vs-object memory).
 */
export const readRuntimeConfig = (installation: any): Record<string, any> => {
  const config = installation?.config;
  if (!config) return {};
  const runtime = typeof config.get === 'function' ? config.get('runtime') : config.runtime;
  return runtime && typeof runtime === 'object' ? runtime : {};
};

export const isHostedInstallation = (installation: any): boolean => (
  String(readRuntimeConfig(installation).runtimeType || '').trim().toLowerCase() === HOSTED_RUNTIME_TYPE
);

const hostedInstallationFilter = (userId: any) => ({
  installedBy: userId,
  status: 'active',
  'config.runtime.runtimeType': HOSTED_RUNTIME_TYPE,
});

// The identity an installation belongs to. The schema lowercases agentName but
// not instanceId, and a row written before it may have neither, so both fold
// here as the runtime-identity collation does (services/runtimeIdentityOwnership).
const hostedIdentityKey = (agentName: unknown, instanceId: unknown): string => (
  `${String(agentName || '').toLowerCase()}:${String(instanceId || 'default').toLowerCase()}`
);

/**
 * Hosted agents owned by a user. Same path the install route writes. A find,
 * not an aggregate: Mongoose casts the string id the routes pass in a find, and
 * a $match on it would match nothing, which fails the cap open.
 */
export const countHostedAgentsForUser = async (userId: any): Promise<number> => {
  const rows = await AgentInstallation.find(hostedInstallationFilter(userId))
    .select('agentName instanceId')
    .lean();
  return new Set((Array.isArray(rows) ? rows : [])
    .map((row: any) => hostedIdentityKey(row.agentName, row.instanceId))).size;
};

export interface HostedInstallationSummary {
  agentName: string;
  instanceId: string;
  podId: string;
  displayName?: string;
}

/**
 * The agents a user hosts, each once, at the room it joined first. Only the
 * owner-safe identity needed to recover from a cap error: failed provisioning
 * leaves the active installation in place, so a count alone strands the user
 * with no way to tell which seat must be removed. Callers count this list as
 * agents (Scout's offer does), so it stays one entry per agent. Never return
 * config or runtime tokens from this helper.
 */
export const listHostedInstallationsForUser = async (userId: any): Promise<HostedInstallationSummary[]> => {
  const rows = await AgentInstallation.find(hostedInstallationFilter(userId))
    .select('agentName instanceId podId displayName')
    .sort({ _id: 1 })
    .lean();
  const agents = new Map<string, HostedInstallationSummary>();
  (Array.isArray(rows) ? rows : []).forEach((row: any) => {
    const key = hostedIdentityKey(row.agentName, row.instanceId);
    if (!row.agentName || !row.podId || agents.has(key)) return;
    agents.set(key, {
      agentName: String(row.agentName),
      instanceId: String(row.instanceId || 'default'),
      podId: String(row.podId),
      ...(row.displayName ? { displayName: String(row.displayName) } : {}),
    });
  });
  return [...agents.values()];
};

/**
 * This person's own first active hosted row of this identity, or null. Holding
 * it is what makes an install "the same agent in another room", so someone
 * else's row of the name never counts. Carries `config.hosted`, for the install
 * route to keep the agent on its engine; it stays server-side.
 */
export const findHeldHostedInstallation = async (
  userId: any, agentName: string, instanceId: string,
): Promise<Record<string, any> | null> => {
  const rows = await AgentInstallation.find(hostedInstallationFilter(userId))
    .select('agentName instanceId podId config.hosted')
    .sort({ _id: 1 })
    .lean();
  const wanted = hostedIdentityKey(agentName, instanceId);
  return (Array.isArray(rows) ? rows : [])
    .find((row: any) => hostedIdentityKey(row.agentName, row.instanceId) === wanted) || null;
};

/** `config.autoJoinSource` on the row a DM writes so the agent can answer there. */
export const AGENT_ROOM_AUTO_JOIN_SOURCE = 'agent-room-create';

const IDENTITY_COLLATION = { locale: 'en', strength: 2 };

const identityRows = (agentName: string, instanceId: string, extra: Record<string, unknown>) => (
  AgentInstallation.find({
    ...installationIdentityFilter(String(agentName).toLowerCase(), String(instanceId || 'default').toLowerCase()),
    ...extra,
  }).collation(IDENTITY_COLLATION)
);

export interface HostedOwner {
  ownerId: unknown;
  // False when every row the owner has of this agent is uninstalled.
  live: boolean;
}

/**
 * Who owns a hosted agent, as seen by the person opening a DM with it: a person
 * who installed it themselves, on a row that is not a DM's. An agent can be
 * hosted by several people under one identity, so `requesterId`'s own row comes
 * first, then the row of someone hosting it in a pod they share, then the
 * oldest. A DM's own row never names an owner, and neither does a row an agent
 * wrote for itself. Null when no person owns it.
 */
export const resolveHostedOwner = async (
  agentName: string, instanceId: string, requesterId: unknown,
): Promise<HostedOwner | null> => {
  const rows = await identityRows(agentName, instanceId, {
    'config.autoJoinSource': { $ne: AGENT_ROOM_AUTO_JOIN_SOURCE },
  }).select('installedBy podId status config.runtime').sort({ _id: 1 }).lean();
  const hosted = (Array.isArray(rows) ? rows : []).filter((row: any) => row.installedBy && isHostedInstallation(row));
  if (!hosted.length) return null;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const Pod = require('../models/Pod');
  const people = await User.find({
    _id: { $in: hosted.map((row: any) => row.installedBy) }, isBot: { $ne: true },
  }).select('_id').lean();
  const personIds = new Set(people.map((person: any) => String(person._id)));
  const owned = hosted.filter((row: any) => personIds.has(String(row.installedBy)));
  if (!owned.length) return null;
  const standing = owned.filter((row: any) => row.status !== 'uninstalled');
  const pool: any[] = standing.length ? standing : owned;
  const shared = await Pod.find({ _id: { $in: pool.map((row) => row.podId) }, members: requesterId })
    .select('_id').lean();
  const sharedIds = new Set(shared.map((pod: any) => String(pod._id)));
  const row = pool.find((candidate) => String(candidate.installedBy) === String(requesterId))
    || pool.find((candidate) => sharedIds.has(String(candidate.podId)))
    || pool[0];
  return { ownerId: row.installedBy, live: standing.length > 0 };
};

/**
 * Ends the DM rows of a hosted agent once its owner has no other row of it, so
 * removing an agent stops it answering and frees the owner's slot. Those rows
 * are the owner's and sit in rooms the owner is not in, so nothing else would
 * reach them. Runs after the owner's row is removed. Never throws: the removal
 * has happened by then, and reassign-hosted-room-owners finishes the job.
 */
export const retireHostedRoomRows = async (
  agentName: string, instanceId: string, ownerId: unknown,
): Promise<number> => {
  try {
    if (!ownerId) return 0;
    const rows = await identityRows(agentName, instanceId, { installedBy: ownerId, status: { $in: ['active', 'paused'] } })
      .select('config.runtime config.autoJoinSource').lean();
    const hosted = (Array.isArray(rows) ? rows : []).filter((row: any) => isHostedInstallation(row));
    const inRoomsOnly = hosted.every((row: any) => row.config?.autoJoinSource === AGENT_ROOM_AUTO_JOIN_SOURCE);
    if (!hosted.length || !inRoomsOnly) return 0;
    await AgentInstallation.updateMany(
      { _id: { $in: hosted.map((row: any) => row._id) } },
      { $set: { status: 'uninstalled' } },
    );
    return hosted.length;
  } catch (error) {
    console.warn('[hosted] ending the DM rows of a removed agent failed:', (error as Error).message);
    return 0;
  }
};

const utcDayStart = (now = new Date()): Date => new Date(Date.UTC(
  now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
));

// The greeting an agent posts when first added is not one of the owner's
// turns (it fires once per person and agent), so the meter does not count it.
export const turnsToday = async (agentName: string, instanceId: string): Promise<number> => (
  AgentEvent.countDocuments({
    agentName: String(agentName).toLowerCase(),
    instanceId: instanceId || 'default',
    status: 'acked',
    deliveredAt: { $gte: utcDayStart() },
    type: { $ne: 'first_contact' },
  })
);

// On the native engine a turn is a run: an AgentRun is created only when the
// model is actually called. The event count above also counts an event that
// was acked without a run, such as an addressed turn that stood down to a
// peer's claim (QA walk 4, 2026-10-16: the ask got no answer and still showed
// as a used turn). The greeting is left out here too, and so is a run that
// failed and posted nothing (`metered: false`): the person got no answer.
// `ownerId` narrows it to one owner's plan line: a published agent can be hosted
// by several people under one identity, and each has their own.
export const nativeTurnsToday = async (agentName: string, instanceId: string, ownerId?: string): Promise<number> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentRun = require('../models/AgentRun');
  return AgentRun.countDocuments({
    agentName: String(agentName).toLowerCase(),
    instanceId: instanceId || 'default',
    startedAt: { $gte: utcDayStart() },
    trigger: { $ne: 'first_contact' },
    metered: { $ne: false },
    ...(ownerId ? { userId: ownerId } : {}),
  });
};

export interface MeterResult {
  allowed: boolean;
  used: number;
  cap: number;
  resetsAt: string;
}

export const meterAllowsTurn = async (
  agentName: string,
  instanceId: string,
  turnsPerDay: number = hostedCaps().turnsPerDay,
  // True for a native-engine install, whose turns are runs, not acked events.
  { countRuns = false, ownerId }: { countRuns?: boolean; ownerId?: string } = {},
): Promise<MeterResult> => {
  const used = countRuns
    ? await nativeTurnsToday(agentName, instanceId, ownerId)
    : await turnsToday(agentName, instanceId);
  const tomorrow = new Date(utcDayStart().getTime() + 24 * 60 * 60 * 1000);
  return {
    allowed: used < turnsPerDay,
    used,
    cap: turnsPerDay,
    resetsAt: tomorrow.toISOString(),
  };
};

export class HostedRuntimeError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HostedRuntimeError';
    this.status = status;
  }
}

const workerRequest = async (
  path: string,
  init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
): Promise<any> => {
  const { url, adminToken } = hostedRuntimeConfig();
  if (!url || !adminToken) {
    throw new HostedRuntimeError('Hosted runtime is not configured', 503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'commonly-backend/hosted-runtime',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (error: any) {
    throw new HostedRuntimeError(
      `Hosted runtime unreachable: ${error?.name === 'AbortError' ? 'timeout' : error?.message}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new HostedRuntimeError(
      `Hosted runtime responded ${response.status}: ${data?.error || text || 'no body'}`,
      502,
    );
  }
  return data;
};

const agentPath = (agentName: string, instanceId: string, tail: string) => (
  `/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId || 'default')}/${tail}`
);

export const provisionAgent = async (params: {
  agentName: string;
  instanceId: string;
  runtimeToken: string;
  pollSeconds?: number;
}): Promise<any> => workerRequest(agentPath(params.agentName, params.instanceId, 'provision'), {
  method: 'POST',
  body: {
    agentName: params.agentName,
    instanceId: params.instanceId || 'default',
    runtimeToken: params.runtimeToken,
    ...(params.pollSeconds ? { pollSeconds: params.pollSeconds } : {}),
  },
});

export const deprovisionAgent = async (agentName: string, instanceId: string): Promise<any> => (
  workerRequest(agentPath(agentName, instanceId, 'deprovision'), { method: 'POST' })
);

export const getAgentStatus = async (agentName: string, instanceId: string): Promise<any> => (
  workerRequest(agentPath(agentName, instanceId, 'status'), { method: 'GET' })
);

module.exports = {
  HOSTED_RUNTIME_TYPE,
  hostedCaps,
  ownerIsPro,
  hostedCapsForOwner,
  userRunCeilingForOwner,
  hostedRuntimeConfig,
  isConfigured,
  readRuntimeConfig,
  isHostedInstallation,
  countHostedAgentsForUser,
  listHostedInstallationsForUser,
  findHeldHostedInstallation,
  AGENT_ROOM_AUTO_JOIN_SOURCE,
  resolveHostedOwner,
  retireHostedRoomRows,
  turnsToday,
  nativeTurnsToday,
  meterAllowsTurn,
  HostedRuntimeError,
  provisionAgent,
  deprovisionAgent,
  getAgentStatus,
};
