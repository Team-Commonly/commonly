import type { NativeAgentDefinition } from './types';

export type { NativeAgentDefinition, NativeAgentTrigger, CommonlyTool } from './types';

/**
 * The registry of all first-party native agents.
 *
 * Round 2 populates this array with real apps (pod-welcomer, task-clerk,
 * pod-summarizer). Round 1 leaves it empty — the hello-native validator
 * lives in backend/config/native-agents/ and is seeded separately.
 */
export const FIRST_PARTY_APPS: NativeAgentDefinition[] = [];
