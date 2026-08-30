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
 *   HOSTED_AGENTS_PER_USER  active hosted installations per owner (default 1)
 *   HOSTED_TURNS_PER_DAY    acked events per hosted agent per UTC day (200)
 *
 * A "turn" is counted as an acked AgentEvent for the agent — the kernel sees
 * deliveries, not model calls, and one delivered event is one worker turn.
 * When the daily cap is reached the events feed returns empty for that agent
 * (see agentsRuntime GET /events), so the worker idles rather than spends.
 *
 * Configuration: HOSTED_RUNTIME_URL + HOSTED_RUNTIME_ADMIN_TOKEN. Unset means
 * the surface reports 503 `hosted_runtime_unconfigured` — never a silent
 * fallback to a different runtime.
 */
import { AgentInstallation } from '../models/AgentRegistry';
import AgentEvent from '../models/AgentEvent';

export const HOSTED_RUNTIME_TYPE = 'hosted';

const DEFAULT_AGENTS_PER_USER = 1;
const DEFAULT_TURNS_PER_DAY = 200;
const WORKER_TIMEOUT_MS = 10_000;

const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const hostedCaps = () => ({
  agentsPerUser: intEnv('HOSTED_AGENTS_PER_USER', DEFAULT_AGENTS_PER_USER),
  turnsPerDay: intEnv('HOSTED_TURNS_PER_DAY', DEFAULT_TURNS_PER_DAY),
});

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

/** Active hosted installations owned by a user. Same path the install route writes. */
export const countHostedAgentsForUser = async (userId: any): Promise<number> => (
  AgentInstallation.countDocuments({
    installedBy: userId,
    status: 'active',
    'config.runtime.runtimeType': HOSTED_RUNTIME_TYPE,
  })
);

const utcDayStart = (now = new Date()): Date => new Date(Date.UTC(
  now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
));

export const turnsToday = async (agentName: string, instanceId: string): Promise<number> => (
  AgentEvent.countDocuments({
    agentName: String(agentName).toLowerCase(),
    instanceId: instanceId || 'default',
    status: 'acked',
    createdAt: { $gte: utcDayStart() },
  })
);

export interface MeterResult {
  allowed: boolean;
  used: number;
  cap: number;
  resetsAt: string;
}

export const meterAllowsTurn = async (agentName: string, instanceId: string): Promise<MeterResult> => {
  const { turnsPerDay } = hostedCaps();
  const used = await turnsToday(agentName, instanceId);
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
  hostedRuntimeConfig,
  isConfigured,
  readRuntimeConfig,
  isHostedInstallation,
  countHostedAgentsForUser,
  turnsToday,
  meterAllowsTurn,
  HostedRuntimeError,
  provisionAgent,
  deprovisionAgent,
  getAgentStatus,
};
