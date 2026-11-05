/**
 * Prepare the commonly MCP build before a confined seat's first poll.
 *
 * A confined seat (public, or workspace since TASK-294) runs its MCP server
 * only from a host-prepared build (TASK-273),
 * and the first spawn on an empty home only STARTS preparing one, then refuses
 * its turn. On a fresh machine that refused turn was the person's first
 * @mention, and it waited out the kernel's requeue, about ten minutes (BYO
 * walk, 2026-10-16). `agent run` prepares the build once, before it polls.
 *
 * The gate is the adapters' own: claude.js refuses a workspace seat's turn
 * without that build too. Gated on 'public' alone, a Connect-page Claude Code
 * seat in private pods (trust 'workspace') skipped the warm and its first
 * @mention was refused (prod walk, 2026-11-05).
 */

// The trusts whose spawn requires a host-prepared build.
const CONFINED_TRUSTS = new Set(['public', 'workspace']);

import { normalizeSandboxTrust } from './environment.js';
import { COMMONLY_MCP_SERVER_NAME } from './default-environment.js';
import { WARM_RESULTS, planMcpSpawn, resolveHomeDir } from './mcp-home.js';
import { warmMcpHome } from './mcp-warm-child.mjs';

/** The warm's result when it ran, or null when this seat needed none. */
export const prepareMcpBeforeFirstPoll = async ({
  environment,
  home,
  plan = planMcpSpawn,
  warm = warmMcpHome,
  log = () => {},
} = {}) => {
  if (!CONFINED_TRUSTS.has(normalizeSandboxTrust(environment?.sandbox)?.trust)) return null;
  const server = Array.isArray(environment?.mcp)
    ? environment.mcp.find((entry) => entry?.name === COMMONLY_MCP_SERVER_NAME)
    : null;
  if (!Array.isArray(server?.command)) return null;
  if (plan(server.command, { home }).reason !== 'home-empty') return null;

  log("preparing Commonly's tools on this machine (first run only)...");
  const result = await warm(resolveHomeDir(home), { now: Date.now() });
  if (result === WARM_RESULTS.ADVANCED || result === WARM_RESULTS.CURRENT) {
    log("Commonly's tools are ready");
  } else {
    log(`could not prepare Commonly's tools yet (${result}); the first turn will try again`);
  }
  return result;
};

export default { prepareMcpBeforeFirstPoll };
