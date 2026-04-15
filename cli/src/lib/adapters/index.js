/**
 * Adapter registry — ADR-005 §Adapter pattern.
 *
 * `attach <adapter>` and `run <name>` both resolve an adapter by its string
 * name through this single registry. Adding a new CLI (claude, codex, cursor,
 * gemini, …) is a one-file PR that exports a default adapter and adds an
 * entry below.
 */

import stub from './stub.js';

const ADAPTERS = {
  [stub.name]: stub,
};

export const listAdapterNames = () => Object.keys(ADAPTERS);

export const getAdapter = (name) => ADAPTERS[name] || null;
