/**
 * Refuse before open (F535, D318): a sandbox option the seat's adapter can't
 * enforce fails the seat at start, never drops silently. One check for config,
 * attach and run (the daemon starts seats through run), beside providerRefusal.
 *
 * Each rule below is a shape that was accepted and then not enforced (the
 * 11-15 audit on main 10364a0c):
 *  - network.allow-hosts on an open network: the schema reads it and no
 *    adapter does, so every host stays reachable. Beside a restricted network
 *    it only asks for less than it gets, and the rules below decide.
 *  - network.policy=restricted under macOS Seatbelt on claude, opencode or
 *    qwen: the profile keeps the network on for the model and MCP. Under bwrap
 *    claude and qwen refuse it already, and opencode restricts it.
 *  - sandbox.mode on a seat with no public or workspace trust: claude (any mode
 *    but bwrap), opencode and qwen spawn bare. codex runs every such seat in
 *    its one private profile (workspace writable, network on), so it keeps
 *    mode workspace and refuses read-only. dsh enforces its one shape.
 *  - network or filesystem rules on a seat with no trust: nothing reads them
 *    when there is no mode, and codex's private profile never does.
 * An open network policy and empty lists ask for nothing, so they pass.
 * The test-only `stub` adapter runs nothing and is not checked.
 */
import { normalizeSandboxTrust } from './environment.js';
import { resolvePublicSandboxMode } from './sandbox/mode.js';
import { adapterConfinesItself } from './unconfined-seat-guard.js';

const SEATBELT_MODES = new Set(['workspace', 'read-only']);
const SEATBELT_NETWORK_KEPT = new Set(['claude', 'opencode', 'qwen']);
// The modes an adapter honours on a seat with no confined trust (dsh's one
// shape returns earlier, through adapterConfinesItself).
const MODES_WITHOUT_TRUST = { codex: new Set(['workspace']) };
const UNCHECKED = new Set(['stub']);

const declares = (value) => value !== undefined && value !== null && value !== ''
  && !(Array.isArray(value) && value.length === 0)
  && !(typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => !declares(v)));
// A rule asks for something unless it is an open network or an empty list.
const asksFor = (key, rules) => {
  if (!rules || typeof rules !== 'object') return declares(rules);
  return Object.entries(rules).some(([name, value]) => declares(value)
    && !(key === 'network' && name === 'policy' && value === 'unrestricted'));
};

/** Null when every sandbox option the seat declares is enforced, otherwise why not. */
export const sandboxOptionRefusal = (environment, adapterName, platform = process.platform) => {
  if (!environment?.sandbox || UNCHECKED.has(adapterName)) return null;
  const sandbox = normalizeSandboxTrust(environment.sandbox);
  const adapter = adapterName || 'this';
  const network = sandbox.network || {};
  if (declares(network['allow-hosts']) && network.policy !== 'restricted') {
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
  const hasMode = declares(sandbox.mode) && sandbox.mode !== 'none';
  const ownModes = MODES_WITHOUT_TRUST[adapterName];
  if (hasMode && !ownModes?.has(sandbox.mode)) {
    return ownModes
      ? `The ${adapter} adapter runs a seat with no sandbox.trust in one private profile (workspace writable, network on), `
        + `so sandbox.mode=${sandbox.mode} would not apply. Add sandbox.trust=public, or remove sandbox.mode.`
      : `The ${adapter} adapter applies sandbox.mode=${sandbox.mode} only with sandbox.trust=public, so this seat would run `
        + 'without a sandbox. Add sandbox.trust=public, or remove sandbox.mode.';
  }
  const rules = ['network', 'filesystem'].filter((key) => asksFor(key, sandbox[key]));
  if (rules.length) {
    const they = rules.length > 1;
    return hasMode
      ? `sandbox.${rules.join(' and sandbox.')} ${they ? 'are' : 'is'} not applied by the ${adapter} adapter's private profile. `
        + `Add sandbox.trust=public, or remove ${they ? 'them' : 'it'}.`
      : `sandbox.${rules.join(' and sandbox.')} ${they ? 'are' : 'is'} enforced only inside a sandbox, and this `
        + `${adapter} seat has none. Add sandbox.trust=public, or remove ${they ? 'them' : 'it'}.`;
  }
  return null;
};

export default sandboxOptionRefusal;
