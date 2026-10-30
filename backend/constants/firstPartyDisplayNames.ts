/**
 * Curated labels for first-party agents that have no AGENT_TYPES entry.
 *
 * getOrCreateAgentUser falls back to the bare agentName when a caller passes
 * no displayName and the type has no officialDisplayName. Scout has no
 * AGENT_TYPES entry, so its User row was stored as "scout" (TASK-551). Each
 * value must equal the agent's native-agents displayName; the collision
 * resolver test pins scout's entry to backend/config/native-agents/scout.ts.
 *
 * No imports: the repair script reads this without loading the service.
 */
export const FIRST_PARTY_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  ['scout', 'Scout'],
]);
