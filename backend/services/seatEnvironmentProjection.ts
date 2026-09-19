// The identity → environment projection the daemon's work list is built from.
//
// It lives here rather than inline in `routes/agentBinding.ts` because TWO
// surfaces have to agree on it: the projection that INJECTS the grant broker
// (TASK-063, server half) and the grant read that has to tell the person who
// minted a grant that it is being withheld (`routes/grants.ts`). Restating
// either the projection or the confinement predicate in the read path is the
// second definition the TASK-063 ruling forbids, so both call these functions.
//
// The projection is also a security boundary in its own right: the daemon's
// bearer must not become a read-all view of an installation's opaque config.
import { AgentInstallation } from '../models/AgentRegistry';

// The daemon needs the driver-neutral ADR-008 shape, but its bearer must not
// become a read-all projection of an installation's opaque config. Keep this
// allow-list aligned with environment.js and discard future/accidental keys at
// the server boundary. MCP env values are declarations (usually placeholders);
// provider secrets remain out-of-band per ADR-008. Only exact placeholder
// values that the local adapters resolve are retained; literal MCP env values
// must never cross the daemon-token boundary. Command and URL fields remain
// declarative inputs and are intentionally outside this env-value filter.
const MCP_PLACEHOLDERS = new Set([
  '${COMMONLY_AGENT_TOKEN}',
  '${COMMONLY_API_URL}',
  '${COMMONLY_INSTANCE_URL}',
]);

export const GRANT_BROKER_AUTHORIZATION = 'Bearer ${COMMONLY_AGENT_TOKEN}';

const projectMcpEnv = (raw: unknown, serverName: string): Record<string, string> | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && MCP_PLACEHOLDERS.has(value)) {
      projected[key] = value;
    } else if (typeof value === 'string' && value.includes('${COMMONLY_')) {
      // Adapters resolve placeholders embedded in command/URL-like values,
      // but env projections deliberately accept only a placeholder by itself.
      // Warn without logging the value so an operator can repair the spec.
      console.warn('[agent-binding] dropped MCP env placeholder declaration', {
        server: serverName,
        key,
      });
    }
  }
  return Object.keys(projected).length ? projected : null;
};

// HTTP MCP servers authenticate with a declarative header rather than a
// process environment variable. Keep the same placeholder-only boundary as
// MCP env so an installation cannot smuggle a bearer or arbitrary header into
// the daemon work list. The broker projection below creates this exact shape
// for each active grant.
const projectMcpHeaders = (raw: unknown, serverName: string): Record<string, string> | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'Authorization' && value === GRANT_BROKER_AUTHORIZATION) {
      projected[key] = value;
    } else if (typeof value === 'string' && value.includes('${COMMONLY_')) {
      console.warn('[agent-binding] dropped MCP header placeholder declaration', {
        server: serverName,
        key,
      });
    }
  }
  return Object.keys(projected).length ? projected : null;
};

const projectEnvironment = (raw: unknown): Record<string, unknown> | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, any>;
  const projected: Record<string, any> = {};
  const pick = (value: unknown, keys: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const picked: Record<string, unknown> = {};
    for (const key of keys) {
      if ((value as Record<string, unknown>)[key] !== undefined) {
        picked[key] = (value as Record<string, unknown>)[key];
      }
    }
    return Object.keys(picked).length ? picked : null;
  };
  for (const key of ['version', 'model', 'effort']) {
    if (source[key] !== undefined) projected[key] = source[key];
  }
  const workspace = pick(source.workspace, ['path', 'seed']);
  if (workspace) projected.workspace = workspace;
  const sandbox = pick(source.sandbox, ['mode', 'trust']);
  if (sandbox) projected.sandbox = sandbox;
  const network = pick(source.sandbox?.network, ['policy', 'allow-hosts']);
  if (network) projected.sandbox = { ...(projected.sandbox || {}), network };
  const filesystem = pick(source.sandbox?.filesystem, ['read-outside', 'write-outside']);
  if (filesystem) projected.sandbox = { ...(projected.sandbox || {}), filesystem };
  const skills = pick(source.skills, ['claude', 'commonly']);
  if (skills) projected.skills = skills;
  if (Array.isArray(source.mcp)) {
    const mcp = source.mcp
      .filter((server: any) => server && typeof server === 'object' && !Array.isArray(server))
      .map((server: Record<string, any>) => {
        const entry: Record<string, unknown> = {};
        for (const key of ['name', 'transport', 'url', 'command']) {
          if (server[key] !== undefined) entry[key] = server[key];
        }
        const serverName = typeof server.name === 'string' ? server.name : 'unknown';
        const env = projectMcpEnv(server.env, serverName);
        if (env) entry.env = env;
        const headers = projectMcpHeaders(server.headers, serverName);
        if (headers) entry.headers = headers;
        return entry;
      })
      .filter((server: Record<string, unknown>) => Object.keys(server).length);
    if (mcp.length) projected.mcp = mcp;
  }
  return Object.keys(projected).length ? projected : null;
};

/** Identity parts are compared the way the daemon keys its work list. */
export const normalizeIdentityPart = (v: unknown): string => String(v ?? '').trim().toLowerCase();

export type SeatEnvironmentEntry = {
  agentName: string;
  instanceId: string;
  podIds: string[];
  runtime: unknown;
  environment: Record<string, unknown> | null;
};

export type SeatEnvironmentQuery = {
  /**
   * Daemon-projection scope: one owner's active installations. The only scope
   * either caller uses — `/assigned` resolves through the machine's owner, and
   * the grant read mirrors it. An identity-wide scan was deliberately dropped
   * (Vera 69881): for a seat with no machine binding it returned whichever row
   * Mongo happened to order first, which is a guess dressed as a verdict.
   */
  installedBy?: unknown;
};

/**
 * The identity key both the daemon list and the grant read resolve on. The
 * schema lowercases `agentName` but NOT `instanceId`, so a raw string compare
 * would miss a seat stored as `Quill`.
 */
export const seatEnvironmentKey = (agentName: unknown, instanceId: unknown): string => (
  `${normalizeIdentityPart(agentName)}\0${normalizeIdentityPart(instanceId) || 'default'}`
);

/**
 * Project active installations into `identity key → what the daemon receives`.
 *
 * First declaration wins for a duplicated identity, exactly as the daemon list
 * has always resolved it; no ordering is imposed here, so the behaviour is the
 * stored order rather than a new rule.
 */
export const projectSeatEnvironments = async (
  query: SeatEnvironmentQuery = {},
): Promise<Map<string, SeatEnvironmentEntry>> => {
  const filter: Record<string, unknown> = { status: 'active' };
  if (query.installedBy) filter.installedBy = query.installedBy;
  const installs = await AgentInstallation.find(filter)
    .select('agentName instanceId podId config')
    .lean();
  const byIdentity = new Map<string, SeatEnvironmentEntry>();
  for (const install of installs) {
    const agentName = normalizeIdentityPart(install.agentName);
    const instanceId = normalizeIdentityPart(install.instanceId) || 'default';
    const key = seatEnvironmentKey(agentName, instanceId);
    const entry = byIdentity.get(key) || {
      agentName, instanceId, podIds: [], runtime: null, environment: null,
    };
    if (install.podId) entry.podIds.push(String(install.podId));
    // AgentInstallation.config is a Mongoose Map; lean() yields a plain
    // object, but stay defensive about both shapes.
    const config = install.config instanceof Map
      ? Object.fromEntries(install.config)
      : (install.config || {});
    if (!entry.runtime && config.runtime) entry.runtime = config.runtime;
    if (!entry.environment && config.environment) entry.environment = projectEnvironment(config.environment);
    byIdentity.set(key, entry);
  }
  return byIdentity;
};
