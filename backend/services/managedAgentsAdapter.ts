/**
 * Managed Agents Adapter
 *
 * Thin wrapper around Anthropic's Claude Managed Agents beta API
 * (https://platform.claude.com/docs/en/managed-agents/quickstart).
 *
 * Scaffolding only. As of 2026-04-11 the `ANTHROPIC_API_KEY` ESO mapping is
 * wired for the backend pod, but the actual value in GCP Secret Manager is
 * literally the string "placeholder". Every core API function first checks
 * `isManagedAgentsAvailable()` and throws a typed `ManagedAgentsError` of
 * kind `not_configured` if the key is missing or still the placeholder.
 * Once a real key lands, these functions immediately start working — no
 * code changes required.
 *
 * Design:
 *   - Uses `globalThis.fetch` (Node 18+), no SDK dependency
 *   - Always sends `anthropic-beta: managed-agents-2026-04-01` header
 *   - Parses `response.body.error.type`/`.message` into typed error kinds
 *     matching the Anthropic error taxonomy
 *
 * Reference: https://platform.claude.com/docs/en/managed-agents/overview
 */

/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Definition of an agent on the Managed Agents API.
 * Corresponds to the body of `POST /v1/beta/agents`.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#create-an-agent
 */
export interface ManagedAgentDef {
  id: string; // agent id from the API
  name: string;
  model: string; // e.g. 'claude-sonnet-4-6'
  systemPrompt: string;
  version?: string;
  callableAgents?: Array<{ id: string; version?: string }>;
}

/**
 * A managed cloud environment (container config) that sessions execute in.
 * Corresponds to the body of `POST /v1/beta/environments`.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#create-an-environment
 */
export interface ManagedEnvironment {
  id: string;
  name: string;
}

/**
 * A running session of an agent in an environment. Persistent and resumable.
 * Corresponds to `POST /v1/beta/sessions`.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#create-a-session
 */
export interface ManagedSession {
  id: string;
  agentId: string;
  environmentId: string;
  status: 'running' | 'idle' | 'closed' | 'failed';
  createdAt: Date;
}

/**
 * An event streamed from a session. Seen via
 * `GET /v1/beta/sessions/:id/events` or the SSE `/stream` variant.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#stream-events
 */
export interface ManagedAgentsEvent {
  type:
    | 'agent.message'
    | 'tool_use'
    | 'tool_result'
    | 'session.status_idle'
    | 'session.status_running'
    | 'session.error';
  content?: Array<{ type: 'text'; text: string }>;
  [key: string]: unknown;
}

// ----------------------------------------------------------------------------
// Typed error
// ----------------------------------------------------------------------------

/**
 * Typed error for all Managed Agents adapter calls. The `kind` field maps
 * to the Anthropic error taxonomy (`authentication_error`, `rate_limit_error`,
 * etc.) plus a `not_configured` sentinel used when the API key is missing
 * or set to the `"placeholder"` value.
 */
export class ManagedAgentsError extends Error {
  kind:
    | 'not_configured'
    | 'auth'
    | 'rate_limit'
    | 'network'
    | 'invalid_request'
    | 'server'
    | 'unknown';

  status?: number;

  constructor(
    message: string,
    kind: ManagedAgentsError['kind'],
    status?: number,
  ) {
    super(message);
    this.name = 'ManagedAgentsError';
    this.kind = kind;
    this.status = status;
  }
}

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const BETA_HEADER = 'managed-agents-2026-04-01';
const ANTHROPIC_VERSION = '2023-06-01';

const getBaseUrl = (): string => (
  (process.env.MANAGED_AGENTS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
);

const getApiKey = (): string => (process.env.ANTHROPIC_API_KEY || '').trim();

const buildHeaders = (): Record<string, string> => ({
  'x-api-key': getApiKey(),
  'anthropic-version': ANTHROPIC_VERSION,
  'anthropic-beta': BETA_HEADER,
  'content-type': 'application/json',
});

/**
 * Returns `true` iff `ANTHROPIC_API_KEY` is set, non-empty, and NOT the
 * literal string `"placeholder"` — which is the current GCP Secret Manager
 * value as of 2026-04-11 (see `managed-agents` skill for the rollout plan).
 */
export function isManagedAgentsAvailable(): boolean {
  const key = getApiKey();
  if (!key) return false;
  if (key === 'placeholder') return false;
  return true;
}

const assertAvailable = (): void => {
  if (!isManagedAgentsAvailable()) {
    throw new ManagedAgentsError(
      'managed-agents not configured — ANTHROPIC_API_KEY is missing or placeholder',
      'not_configured',
    );
  }
};

// ----------------------------------------------------------------------------
// Error classification
// ----------------------------------------------------------------------------

const classifyAnthropicError = (
  status: number,
  body: any,
): ManagedAgentsError => {
  const errType: string | undefined = body?.error?.type;
  const errMsg: string =
    body?.error?.message
    || body?.message
    || `Managed Agents HTTP ${status}`;

  // Map by error type first, then fall back to HTTP status.
  if (errType === 'authentication_error' || status === 401 || status === 403) {
    return new ManagedAgentsError(`auth: ${errMsg}`, 'auth', status);
  }
  if (errType === 'rate_limit_error' || status === 429) {
    return new ManagedAgentsError(`rate_limit: ${errMsg}`, 'rate_limit', status);
  }
  if (errType === 'invalid_request_error' || status === 400 || status === 404 || status === 422) {
    return new ManagedAgentsError(
      `invalid_request: ${errMsg}`,
      'invalid_request',
      status,
    );
  }
  if (
    errType === 'api_error'
    || errType === 'overloaded_error'
    || (typeof status === 'number' && status >= 500)
  ) {
    return new ManagedAgentsError(`server: ${errMsg}`, 'server', status);
  }
  return new ManagedAgentsError(errMsg, 'unknown', status);
};

const classifyNetworkError = (err: any): ManagedAgentsError => {
  const code: string | undefined = err?.code || err?.cause?.code;
  const msg: string = err?.message || 'Network error calling Managed Agents API';
  if (
    code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT'
    || code === 'ENOTFOUND'
    || code === 'EAI_AGAIN'
    || code === 'ECONNRESET'
  ) {
    return new ManagedAgentsError(`network: ${msg}`, 'network');
  }
  return new ManagedAgentsError(msg, 'network');
};

// ----------------------------------------------------------------------------
// Fetch helper
// ----------------------------------------------------------------------------

/**
 * Low-level fetch wrapper that adds beta headers, parses JSON, and converts
 * non-2xx responses into `ManagedAgentsError` instances with the right `kind`.
 */
const request = async <T = any>(
  path: string,
  init: {
    method: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
  },
): Promise<T> => {
  const url = `${getBaseUrl()}${path}`;
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: init.method,
      headers: buildHeaders(),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (err: any) {
    throw classifyNetworkError(err);
  }

  const text = await response.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    throw classifyAnthropicError(response.status, parsed);
  }
  return parsed as T;
};

// ----------------------------------------------------------------------------
// Core API
// ----------------------------------------------------------------------------

/**
 * Create a reusable agent definition.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#create-an-agent
 */
export async function createAgent(
  def: Omit<ManagedAgentDef, 'id' | 'version'>,
): Promise<ManagedAgentDef> {
  assertAvailable();
  const body: Record<string, unknown> = {
    name: def.name,
    model: def.model,
    system: def.systemPrompt,
    // Default to the built-in agent toolset (bash/file/web-search/MCP) —
    // callers can wrap this adapter to pass a richer tool list later.
    tools: [{ type: 'agent_toolset_20260401' }],
  };
  if (def.callableAgents && def.callableAgents.length > 0) {
    body.callable_agents = def.callableAgents.map((a) => ({
      type: 'agent',
      id: a.id,
      ...(a.version ? { version: a.version } : {}),
    }));
  }
  const resp = await request<any>('/v1/beta/agents', {
    method: 'POST',
    body,
  });
  return {
    id: resp.id,
    name: resp.name ?? def.name,
    model: resp.model ?? def.model,
    systemPrompt: resp.system ?? def.systemPrompt,
    version: resp.version,
    callableAgents: def.callableAgents,
  };
}

/**
 * Create a cloud environment (container config) that sessions will run in.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#create-an-environment
 */
export async function createEnvironment(
  name: string,
  config?: unknown,
): Promise<ManagedEnvironment> {
  assertAvailable();
  const body: Record<string, unknown> = {
    name,
    // Default environment config: cloud container, unrestricted networking.
    // Callers can override by passing an explicit `config` object.
    config: config ?? { type: 'cloud', networking: { type: 'unrestricted' } },
  };
  const resp = await request<any>('/v1/beta/environments', {
    method: 'POST',
    body,
  });
  return {
    id: resp.id,
    name: resp.name ?? name,
  };
}

/**
 * Start a new session of `agentId` inside `environmentId`.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#create-a-session
 */
export async function createSession(
  agentId: string,
  environmentId: string,
  title?: string,
): Promise<ManagedSession> {
  assertAvailable();
  const body: Record<string, unknown> = {
    agent: agentId,
    environment_id: environmentId,
  };
  if (title) body.title = title;
  const resp = await request<any>('/v1/beta/sessions', {
    method: 'POST',
    body,
  });
  return {
    id: resp.id,
    agentId: resp.agent ?? agentId,
    environmentId: resp.environment_id ?? environmentId,
    status: (resp.status as ManagedSession['status']) ?? 'running',
    createdAt: resp.created_at ? new Date(resp.created_at) : new Date(),
  };
}

/**
 * Send a `user.message` event to an active session.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#send-a-user-message
 */
export async function sendUserMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  assertAvailable();
  await request<any>(`/v1/beta/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: 'POST',
    body: {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text }],
        },
      ],
    },
  });
}

/**
 * Read events from a session. Optionally resume after a previously-seen
 * event id. This is the non-streaming variant; callers that need a live
 * SSE stream should add a separate helper later.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#stream-events
 */
export async function readSessionEvents(
  sessionId: string,
  opts?: { afterEventId?: string },
): Promise<ManagedAgentsEvent[]> {
  assertAvailable();
  const query = opts?.afterEventId
    ? `?after=${encodeURIComponent(opts.afterEventId)}`
    : '';
  const resp = await request<any>(
    `/v1/beta/sessions/${encodeURIComponent(sessionId)}/events${query}`,
    { method: 'GET' },
  );
  const raw: any[] = Array.isArray(resp?.events) ? resp.events : [];
  return raw.map((e) => ({
    type: e.type,
    content: e.content,
    ...e,
  })) as ManagedAgentsEvent[];
}

/**
 * Close (and bill-stop) a session. Safe to call on an already-closed session.
 * https://platform.claude.com/docs/en/managed-agents/quickstart#close-a-session
 */
export async function closeSession(sessionId: string): Promise<void> {
  assertAvailable();
  await request<any>(`/v1/beta/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

// ----------------------------------------------------------------------------
// Default + CJS compat
// ----------------------------------------------------------------------------

export default {
  isManagedAgentsAvailable,
  createAgent,
  createEnvironment,
  createSession,
  sendUserMessage,
  readSessionEvents,
  closeSession,
  ManagedAgentsError,
};

// CJS compat: let `require('./managedAgentsAdapter')` return the named
// exports directly — matches the idiom used by openaiImageService.ts /
// pgRetentionService.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
