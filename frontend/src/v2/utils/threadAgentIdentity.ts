import type { V2Agent } from '../hooks/useV2PodDetail';

export const normalizeAgentSegment = (value: string | undefined): string => (
  value || ''
).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

// Per-user agent instance tokens are machine keys, while a human-chosen
// instanceId is an identity. Never make an opaque token part of a mention.
export const isOpaqueInstanceToken = (value: string | undefined): boolean => (
  /^u[a-f0-9]{10}([a-f0-9]{14})?$/.test((value || '').toLowerCase())
);

// Mirrors agentMentionService's backend slugification. Handles must resolve
// exactly the same way in the composer and in delivery.
export const slugifyAgentHandle = (value: string | undefined): string => (value || '')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

/** Mirrors AgentIdentityService.buildAgentUsername on the backend. */
export const buildAgentUsername = (agentName: string | undefined, instanceId: string | undefined): string => {
  const base = normalizeAgentSegment(agentName);
  const instance = normalizeAgentSegment(instanceId);
  if (!instance || instance === 'default' || instance === base) return base || 'agent';
  return `${base}-${instance}`;
};

export const rawAgentName = (agent: V2Agent): string => (
  (agent as { name?: string; agentName?: string }).name || agent.agentName || ''
);
