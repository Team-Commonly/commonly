import { useMemo } from 'react';
import type { V2Agent } from '../hooks/useV2PodDetail';
import type { V2PodMember } from '../hooks/useV2Pods';
import {
  buildAgentUsername,
  isOpaqueInstanceToken,
  rawAgentName,
  slugifyAgentHandle,
} from './threadAgentIdentity';
import { mentionHandleFor } from './agentMentionHandle';

/**
 * F645. A handle is the stable mention key: it is what the message stores and
 * what the server resolves. A person reads the display name. This maps each
 * lowercase handle a pod can mention to the name people know it by.
 */
export type MentionLabels = Map<string, string>;

/**
 * The name an agent's install chose (its displayName), or a human-chosen
 * instanceId. People picked either one, so it shows even when it matches the
 * runtime's name ("Claude Code" on claude-code). The runtime `agentName`
 * itself is never a label.
 */
export const agentChosenName = (agent: V2Agent): string => {
  const instance = (agent.instanceId || 'default').toLowerCase();
  return agent.displayName?.trim()
    || agent.profile?.displayName?.trim()
    || (instance !== 'default' && !isOpaqueInstanceToken(instance) ? instance : '');
};

/**
 * Agent User-row username → the name its messages are signed with. The author
 * line and the mention labels both read this one map, so a chip and the byline
 * on the same agent's messages can't disagree. Keys mirror the backend's
 * buildAgentUsername: '<agentName>' for a default instance, else
 * '<agentName>-<instanceId>'.
 *
 * The backend payload key is `name` (buildAgentInstallationPayload), while
 * V2Agent declares `agentName`; rawAgentName reads both.
 */
export const buildAgentDisplayNames = (agents: V2Agent[] = []): Map<string, string> => {
  const map = new Map<string, string>();
  agents.forEach((agent) => {
    const name = rawAgentName(agent).toLowerCase();
    const instance = (agent.instanceId || '').toLowerCase();
    const username = !instance || instance === 'default' || instance === name
      ? name
      : `${name}-${instance}`;
    const display = agentChosenName(agent);
    if (username && display) map.set(username, display);
  });
  return map;
};

/**
 * The name people read for an agent: the name its install chose (the author
 * line's name), then the member's server-resolved `displayLabel`
 * (resolveAgentDisplayLabel), then its username.
 */
export const agentDisplayLabel = (agent: V2Agent, member?: V2PodMember, fallback = ''): string => (
  agentChosenName(agent)
  || member?.displayLabel?.trim()
  || member?.username
  || fallback
);

/** The name people read for a person: their display name, else their handle. */
export const personDisplayLabel = (member: V2PodMember): string => (
  member.displayName?.trim() || member.username || ''
);

/**
 * The handle the composer inserts for an agent (`value`) and the handle it
 * would insert without a sibling install (`usualValue`). Mirrors the backend's
 * mention keys: a human-chosen instanceId, else the display slug.
 */
export const agentMentionValues = (agent: V2Agent, agents: V2Agent[]): { value: string; usualValue: string } => {
  const name = rawAgentName(agent);
  const label = agent.displayName || agent.profile?.displayName || name;
  const instance = (agent.instanceId || 'default').toLowerCase();
  const usualValue = instance && instance !== 'default' && instance !== name.toLowerCase()
    && !isOpaqueInstanceToken(instance)
    ? instance
    : (slugifyAgentHandle(label) || name.toLowerCase());
  return { value: mentionHandleFor(agent, agents) || usualValue, usualValue };
};

export const buildMentionLabels = (members: V2PodMember[] = [], agents: V2Agent[] = []): MentionLabels => {
  const labels: MentionLabels = new Map();
  const memberByUsername = new Map<string, V2PodMember>();
  // People first: a person's handle is never taken by an agent's loose slug key.
  members.forEach((member) => {
    const username = (member?.username || '').toLowerCase();
    if (!username) return;
    memberByUsername.set(username, member);
    if (!member.isBot) {
      const label = personDisplayLabel(member);
      if (label) labels.set(username, label);
    }
  });
  // Then every installed agent, by each handle that reaches it, with the same
  // name its author line shows. Effective handles (the username and the
  // handle the composer inserts) go first for every install; a fallback
  // `usualValue` fills only a key no install owns as its own handle, so a
  // default's display slug can't take a sibling's instanceId handle.
  const entries = agents.flatMap((agent) => {
    const name = rawAgentName(agent);
    if (!name) return [];
    const username = buildAgentUsername(name, agent.instanceId);
    const label = agentDisplayLabel(agent, memberByUsername.get(username));
    if (!label) return [];
    return [{ label, username, ...agentMentionValues(agent, agents) }];
  });
  const claim = (handle: string, label: string) => {
    const key = handle.toLowerCase();
    const owner = memberByUsername.get(key);
    if (!key || (owner && !owner.isBot) || labels.has(key)) return;
    labels.set(key, label);
  };
  entries.forEach(({ label, username, value }) => [username, value].forEach((handle) => claim(handle, label)));
  entries.forEach(({ label, usualValue }) => claim(usualValue, label));
  // A bot member with no install row in this pod keeps the server's label.
  members.forEach((member) => {
    const username = (member?.username || '').toLowerCase();
    const label = member?.displayLabel?.trim();
    if (member?.isBot && username && label && !labels.has(username)) labels.set(username, label);
  });
  return labels;
};

// Only the fields the label map reads, so an equal pod read gives an equal key.
const labelSignature = (members: V2PodMember[], agents: V2Agent[]): string => JSON.stringify([
  members.map((m) => [m?.username, m?.displayName, m?.displayLabel, m?.isBot]),
  agents.map((a) => [rawAgentName(a), a.instanceId, a.displayName, a.profile?.displayName]),
]);

/**
 * The label map for a pod, rebuilt only when a name in it changes. A parent
 * re-render with fresh but equal arrays keeps the same Map, so the context
 * value, and every memoized row reading it, stays put.
 */
export const useMentionLabelMap = (members: V2PodMember[] = [], agents: V2Agent[] = []): MentionLabels => {
  const signature = labelSignature(members, agents);
  // The signature covers every field buildMentionLabels reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildMentionLabels(members, agents), [signature]);
};
