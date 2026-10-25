/**
 * Point a Claude Code spawn at the supervisor's loopback provider relay.
 *
 * Claude Code reads its Anthropic API base URL from ANTHROPIC_BASE_URL, and
 * calls https://api.anthropic.com without it. The relay keeps the upstream
 * path, so the CLI sees the same API shape either way.
 *
 * Not covered, with the reason, when:
 *   - the spawn is routed to Bedrock, Vertex or Foundry, which take other base
 *     URLs and sign requests a relay would have to understand;
 *   - the seat runs under bwrap with a restricted network: --unshare-net gives
 *     the child its own network namespace, where 127.0.0.1 is not the relay.
 *
 * A settings file can set ANTHROPIC_BASE_URL too, and wins over the env. That
 * case is not detectable here; the relay reports it at runtime, because no
 * request reaches it.
 */
import { resolvePublicSandboxMode } from '../sandbox/mode.js';

const CLOUD_ROUTES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

const enabled = (value) => typeof value === 'string'
  && value.trim() !== ''
  && !/^(?:0|false|no|off)$/i.test(value.trim());

export const claudeProviderRoute = ({ env = {}, environment = null } = {}) => {
  const cloud = CLOUD_ROUTES.find((name) => enabled(env[name]));
  if (cloud) return { covered: false, reason: `claude is routed to a cloud provider (${cloud}), which the relay does not stand in for` };
  const sandbox = environment?.sandbox;
  // The mode the spawn resolves, not the one the record spells: claude.js
  // wraps with bwrap whenever this resolves to it.
  if (sandbox && resolvePublicSandboxMode(sandbox) === 'bwrap' && sandbox.network?.policy === 'restricted') {
    return { covered: false, reason: 'claude runs under bwrap with a restricted network, where the loopback relay is unreachable' };
  }
  const configured = typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.trim();
  return { covered: true, upstream: configured || DEFAULT_UPSTREAM };
};

/**
 * Set ANTHROPIC_BASE_URL on `claudeEnv` to the relay, or report why not.
 * A no-op without a relay. Returns the env it was given.
 */
export const routeClaudeThroughRelay = ({ relay, claudeEnv, environment }) => {
  if (!relay) return claudeEnv;
  const route = claudeProviderRoute({ env: claudeEnv, environment });
  if (!route.covered) { relay.notCovered(route.reason); return claudeEnv; }
  try {
    claudeEnv.ANTHROPIC_BASE_URL = relay.bind({ upstream: route.upstream });
  } catch (error) {
    relay.notCovered(`claude base URL cannot be relayed: ${error.message}`);
  }
  return claudeEnv;
};
