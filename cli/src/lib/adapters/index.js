/**
 * Adapter registry — ADR-005 §Adapter pattern.
 *
 * `attach <adapter>` and `run <name>` both resolve an adapter by its string
 * name through this single registry. Adding a new CLI (claude, codex, cursor,
 * gemini, …) is a one-file PR that exports a default adapter and adds an
 * entry below.
 */

import stub from './stub.js';
import claude from './claude.js';
import codex from './codex.js';
import pi from './pi.js';

const ADAPTERS = {
  [stub.name]: stub,
  [claude.name]: claude,
  [codex.name]: codex,
  [pi.name]: pi,
};

export const listAdapterNames = () => Object.keys(ADAPTERS);

export const getAdapter = (name) => ADAPTERS[name] || null;

/**
 * TASK-049: the environment a seat's ADAPTER needs from the operator's shell.
 *
 * The adapter owns the provider, so the adapter declares the variable (see
 * `pi.js`); the daemon reads the list to carry those keys into its login
 * service, because launchd and systemd start the daemon with a clean
 * environment — a key that exists only in an interactive shell is absent at
 * boot, and the seat then dies inside its own adapter. An adapter that
 * authenticates through its own CLI (claude, codex) declares nothing here and
 * contributes nothing.
 */
export const providerKeyEnvNames = (adapters = ADAPTERS) => [...new Set(
  Object.values(adapters).map((adapter) => adapter.providerKeyEnv).filter(Boolean),
)];
