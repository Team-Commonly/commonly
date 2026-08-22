// Personal pods are private conversation surfaces. They all require caller
// membership for read/list access and auto-route participant messages to an
// agent. This is deliberately broader than DM_POD_TYPES_GUARD in
// agentIdentityService: agent-admin is an N:1 admin↔agent surface, so it is
// personal and auto-routed without being a strict two-member DM.
//
// Keep this taxonomy separate from the VALID_POD_TYPES lists in the model and
// creation routes. Those answer which shapes a particular writer accepts;
// this answers which persisted pods have personal-conversation behaviour.
export const PERSONAL_POD_TYPES = new Set<string>([
  'agent-admin',
  'agent-room',
  'agent-dm',
]);

export const isPersonalPodType = (type: unknown): boolean => PERSONAL_POD_TYPES.has(String(type));
