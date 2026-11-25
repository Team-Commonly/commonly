import type { V2Agent } from '../hooks/useV2PodDetail';
import { rawAgentName } from './threadAgentIdentity';

// The handle shape the backend's extractMentions reads out of a message.
const MENTIONABLE_HANDLE = /^[a-z0-9_-]{2,}$/;

const instanceOf = (agent: V2Agent): string => (agent.instanceId || 'default').toLowerCase();

/**
 * F607. The explicit handle for a default install that shares the pod with a
 * sibling install of the same agent, or null when the caller's usual handle
 * already reaches it.
 *
 * agentMentionService claims the bare agentName only while a pod holds one
 * install of that agent. Beside a sibling the bare name falls to the loose
 * display-slug key, which the later install takes, so `@<agentName>` can wake
 * the sibling. The explicit `<agentName>-default` key is always claimed for the
 * default install, so that is the handle to insert. A lone default, and every
 * non-default instance, keeps the handle it had.
 */
export const mentionHandleFor = (agent: V2Agent, podAgents: V2Agent[] = []): string | null => {
  const name = rawAgentName(agent).toLowerCase();
  if (!name || instanceOf(agent) !== 'default') return null;
  const explicit = `${name}-default`;
  // A name the backend can't read as a handle (a scoped package) is reached by
  // its canonical username instead, which a sibling never shares.
  if (!MENTIONABLE_HANDLE.test(name) || !MENTIONABLE_HANDLE.test(explicit)) return null;
  const hasSibling = podAgents.some((other) => rawAgentName(other).toLowerCase() === name
    && instanceOf(other) !== 'default');
  return hasSibling ? explicit : null;
};

/**
 * A draft that opens `@<agentName>` for a default install with a sibling in
 * this pod, re-addressed to `@<agentName>-default`. Any other draft comes back
 * unchanged.
 */
export const addressDraftToPod = (draft: string, podAgents: V2Agent[] = []): string => {
  const match = /^@([a-z0-9_-]+)(?=\s|$)/i.exec(draft);
  if (!match) return draft;
  const handle = match[1].toLowerCase();
  const target = podAgents.find((agent) => rawAgentName(agent).toLowerCase() === handle
    && instanceOf(agent) === 'default');
  const explicit = target ? mentionHandleFor(target, podAgents) : null;
  return explicit ? `@${explicit}${draft.slice(match[0].length)}` : draft;
};
