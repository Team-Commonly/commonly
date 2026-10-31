/**
 * Curated labels for the first-party agents in FIRST_PARTY_APPS
 * (backend/config/native-agents/apps.ts), keyed by agentName.
 *
 * Two readers. getOrCreateAgentUser falls back to the curated label when a
 * caller gives no displayName and the type has no officialDisplayName. The
 * collision resolver and the dedupe script treat an agent in this map as
 * first-party (see isFirstPartyAgentName), so its default instance keeps the
 * bare name. The collision test pins every value to its native app config.
 *
 * No imports: the repair and dedupe scripts read this without loading the service.
 */
export const FIRST_PARTY_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  ['pod-welcomer', 'Pod Welcomer'],
  ['task-clerk', 'Task Clerk'],
  ['pod-summarizer', 'Pod Summarizer'],
  ['scout', 'Scout'],
  ['recorder', 'Recorder'],
]);

/**
 * True when an agentName is a first-party app's (a key of this map), compared
 * ignoring case and surrounding space. On a label collision, a first-party
 * agent's default instance keeps the bare name; every other agent keeps the
 * shortest-instanceId rule.
 */
export const isFirstPartyAgentName = (agentName: string): boolean => FIRST_PARTY_DISPLAY_NAMES
  .has((agentName || '').trim().toLowerCase());
