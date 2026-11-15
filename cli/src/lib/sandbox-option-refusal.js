/**
 * Refuse before open (F535, D318): a sandbox option the seat's adapter can't
 * enforce fails the seat at start, never drops silently. One check for config,
 * attach and run (the daemon starts seats through run), beside providerRefusal.
 *
 * Each rule below is a shape that was accepted and then not enforced (the
 * 11-15 audit on main 10364a0c):
 *  - network.allow-hosts: the schema reads it and no adapter does.
 *  - network.policy=restricted under macOS Seatbelt on claude, opencode or
 *    qwen: the profile keeps the network on for the model and MCP. Under bwrap
 *    claude and qwen refuse it already, and opencode restricts it.
 *  - sandbox.mode on a seat with no public or workspace trust: claude (any mode
 *    but bwrap), opencode and qwen spawn bare. codex maps it to its private
 *    profile, and dsh enforces its one shape, so those two keep it.
 *  - network or filesystem rules on a seat with no trust and no mode: nothing
 *    reads them, on any adapter.
 * The test-only `stub` adapter runs nothing and is not checked.
 */
import { normalizeSandboxTrust } from './environment.js';
import { resolvePublicSandboxMode } from './sandbox/mode.js';
import { adapterConfinesItself } from './unconfined-seat-guard.js';

const SEATBELT_MODES = new Set(['workspace', 'read-only']);
const SEATBELT_NETWORK_KEPT = new Set(['claude', 'opencode', 'qwen']);
// Adapters that give a mode meaning on a seat with no confined trust.
const MODE_WITHOUT_TRUST = new Set(['codex', 'dsh']);
const UNCHECKED = new Set(['stub']);

const declares = (value) => value !== undefined && value !== null
  && !(typeof value === 'object' && Object.keys(value).length === 0);

/** Null when every sandbox option the seat declares is enforced, otherwise why not. */
export const sandboxOptionRefusal = (environment, adapterName, platform = process.platform) => {
  if (!environment?.sandbox || UNCHECKED.has(adapterName)) return null;
  const sandbox = normalizeSandboxTrust(environment.sandbox);
  const adapter = adapterName || 'this';
  const network = sandbox.network || {};
  if (declares(network['allow-hosts'])) {
    return `sandbox.network.allow-hosts is not enforced by any adapter yet, so the ${adapter} seat would reach every host. `
      + 'Remove it, or use sandbox.network.policy.';
  }
  if (adapterConfinesItself(adapterName, sandbox)) return null;
  const confined = sandbox.trust === 'public' || sandbox.trust === 'workspace';
  if (confined) {
    const mode = resolvePublicSandboxMode(sandbox, platform);
    if (network.policy === 'restricted' && SEATBELT_MODES.has(mode) && SEATBELT_NETWORK_KEPT.has(adapterName)) {
      return `The ${adapter} adapter can't restrict the network under macOS Seatbelt (sandbox.mode=${mode}): `
        + 'the sandbox keeps it on for the model and MCP. Remove sandbox.network.policy, or run the seat under bwrap on Linux.';
    }
    return null;
  }
  if (declares(sandbox.mode) && sandbox.mode !== 'none' && !MODE_WITHOUT_TRUST.has(adapterName)) {
    return `The ${adapter} adapter applies sandbox.mode=${sandbox.mode} only with sandbox.trust=public, so this seat would run `
      + 'without a sandbox. Add sandbox.trust=public, or remove sandbox.mode.';
  }
  if (!declares(sandbox.mode) || sandbox.mode === 'none') {
    const rules = ['network', 'filesystem'].filter((key) => declares(sandbox[key]));
    if (rules.length) {
      return `sandbox.${rules.join(' and sandbox.')} ${rules.length > 1 ? 'are' : 'is'} enforced only inside a sandbox, and this `
        + `${adapter} seat has none. Add sandbox.trust=public, or remove ${rules.length > 1 ? 'them' : 'it'}.`;
    }
  }
  return null;
};

export default sandboxOptionRefusal;
