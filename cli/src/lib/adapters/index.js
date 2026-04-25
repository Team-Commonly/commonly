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

const ADAPTERS = {
  [stub.name]: stub,
  [claude.name]: claude,
  [codex.name]: codex,
};

export const listAdapterNames = () => Object.keys(ADAPTERS);

export const getAdapter = (name) => ADAPTERS[name] || null;
