import type { V2PodMember } from '../hooks/useV2Pods';

// Pod types that are one conversation with someone, not a named group.
// agent-admin is an owner's private room with their agent.
const DIRECT_POD_TYPES = new Set(['agent-room', 'agent-dm', 'agent-admin']);

interface TabPod {
  name?: string;
  type?: string;
}

/*
 * How an agent or person is named in a DM's tab, in the same order the server
 * labels agents (resolveAgentDisplayLabel): the curated display name, then a
 * non-default instance id, then the username.
 */
export const memberTabLabel = (member: V2PodMember): string => {
  const display = member.botMetadata?.displayName?.trim();
  if (display) return display;
  const instance = member.botMetadata?.instanceId?.trim();
  if (member.isBot && instance && instance !== 'default') return instance;
  return member.username?.trim() || '';
};

/*
 * What a pod's browser tab names. A group pod uses its name. A DM names whoever
 * the viewer is talking to, since its stored name ("DM: …") is plumbing; an
 * observer of two agents' DM sees both. Returns null while there is nothing to
 * name, so the tab keeps its plain title. The caller passes a pod only once the
 * server has returned it, which it does only to someone who can view it.
 */
export const podTabName = (
  pod: TabPod | null | undefined,
  members: V2PodMember[] | null | undefined,
  viewerId: string | null | undefined,
  language: string,
): string | null => {
  if (!pod) return null;
  if (!DIRECT_POD_TYPES.has(pod.type || '')) return pod.name?.trim() || null;
  const others = (members || []).filter((member) => member && member._id !== viewerId);
  // In an owner's room with their agent, the agent is the other party.
  const parties = pod.type === 'agent-admin' && others.some((member) => member.isBot)
    ? others.filter((member) => member.isBot)
    : others;
  const labels = [...new Set(parties.map(memberTabLabel).filter(Boolean))];
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  // Intl.ListFormat is in every browser we support but not in this TS lib.
  const { ListFormat } = Intl as unknown as {
    ListFormat?: new (locale: string, options: { style: string; type: string }) => { format: (list: string[]) => string };
  };
  try {
    if (ListFormat) return new ListFormat(language, { style: 'long', type: 'conjunction' }).format(labels);
  } catch { /* an unknown locale: fall through */ }
  return labels.join(', ');
};
