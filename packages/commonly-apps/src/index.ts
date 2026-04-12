import type { NativeAgentDefinition } from './types';

export type { NativeAgentDefinition, NativeAgentTrigger, CommonlyTool } from './types';

import { podWelcomerApp } from './pod-welcomer';
import { taskClerkApp } from './task-clerk';
import { podSummarizerApp } from './pod-summarizer';

/**
 * The registry of all first-party native agents. Loaded at backend startup
 * by `backend/config/native-agents/apps.ts` and upserted into AgentRegistry
 * by `backend/scripts/seed-native-agents.ts`.
 *
 * To add a new app: create a new folder under src/, export a
 * NativeAgentDefinition, then import and add it to this array.
 */
export const FIRST_PARTY_APPS: NativeAgentDefinition[] = [
  podWelcomerApp,
  taskClerkApp,
  podSummarizerApp,
];
