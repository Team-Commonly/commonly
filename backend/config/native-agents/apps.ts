import type { NativeAgentDefinition } from './types';
import { podWelcomerApp } from './pod-welcomer';
import { taskClerkApp } from './task-clerk';
import { podSummarizerApp } from './pod-summarizer';

export type { NativeAgentDefinition, NativeAgentTrigger, CommonlyTool } from './types';

/**
 * First-party native agent registry — loaded at backend startup by
 * `scripts/seed-native-agents.ts`, upserted into AgentRegistry, and
 * executed in-process by `services/nativeRuntimeService.ts`.
 *
 * Canonical source is here in backend/config/native-agents/ for the MVP.
 * The parallel `packages/commonly-apps/` package holds the same definitions
 * as "future state" — when we set up a proper monorepo build that bundles
 * cross-package code into the backend Docker context, the source of truth
 * moves to packages/ and this file becomes a thin re-export. For now,
 * editing either location is fine as long as they stay in sync.
 *
 * To add a new app: create a new file in this directory exporting a
 * NativeAgentDefinition, then import + add to FIRST_PARTY_APPS below.
 */
export const FIRST_PARTY_APPS: NativeAgentDefinition[] = [
  podWelcomerApp,
  taskClerkApp,
  podSummarizerApp,
];
