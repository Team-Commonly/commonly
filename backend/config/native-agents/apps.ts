import type { NativeAgentDefinition } from './types';

export type { NativeAgentDefinition, NativeAgentTrigger, CommonlyTool } from './types';

/**
 * Backend-side hook for first-party native agents.
 *
 * Round 1 keeps this empty — the hello-native validator is seeded through a
 * separate path. Round 2 will wire this to `packages/commonly-apps` (either
 * by project references, a path alias, or by re-exporting from a shared
 * build output) and populate it with pod-welcomer / task-clerk /
 * pod-summarizer.
 *
 * Do NOT import this from runtime code yet — Round 2 owns that wiring.
 */
export const FIRST_PARTY_APPS: NativeAgentDefinition[] = [];
