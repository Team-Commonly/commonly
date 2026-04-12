import type { NativeAgentDefinition } from './types';

export type { NativeAgentDefinition, NativeAgentTrigger, CommonlyTool } from './types';

/**
 * Backend-side hook for first-party native agents.
 *
 * The canonical registry lives in `packages/commonly-apps/src/index.ts`.
 * Backend's tsconfig is scoped to `backend/` (see tsconfig.typescheck.json),
 * so we can't statically import across the package boundary — a dynamic
 * `require` resolved at runtime via `ts-node --transpile-only` is the
 * pragmatic bridge. The result is coerced into the backend-local mirror
 * type (`./types.ts`), which is kept byte-identical with the package's
 * canonical `types.ts`.
 *
 * If `packages/commonly-apps` isn't present at runtime (or fails to load)
 * we fall back to an empty array so the seed becomes a no-op instead of
 * crashing backend startup.
 */
let LOADED_APPS: NativeAgentDefinition[] = [];
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../../../packages/commonly-apps/src');
  const raw = (pkg && pkg.FIRST_PARTY_APPS) || [];
  LOADED_APPS = Array.isArray(raw) ? (raw as NativeAgentDefinition[]) : [];
} catch (err: unknown) {
  // eslint-disable-next-line no-console
  console.warn(
    '[native-agents] failed to load packages/commonly-apps — FIRST_PARTY_APPS empty:',
    (err as { message?: string })?.message || err,
  );
  LOADED_APPS = [];
}

export const FIRST_PARTY_APPS: NativeAgentDefinition[] = LOADED_APPS;
