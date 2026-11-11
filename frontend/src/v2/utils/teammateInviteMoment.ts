import type { V2Message } from '../hooks/useV2PodDetail';
import type { V2Pod, V2PodMember } from '../hooks/useV2Pods';
import type { TeammateInviteSource } from '../components/V2BringTeammate';

export function isSoloHumanPod(pod: V2Pod, members: V2PodMember[], viewerId: string) {
  if (!viewerId || ['agent-admin', 'agent-room', 'agent-dm'].includes(pod.type || '')) return false;
  // Unknown member types count as human: incomplete metadata must not claim
  // that the viewer is alone in a pod containing another person.
  const humans = members.filter((member) => member.isBot !== true);
  return humans.length === 1 && humans[0]._id === viewerId;
}

export function teammateInviteMoment(
  messages: V2Message[], viewerId: string, agentKeys: Set<string>, scoutKeys: Set<string>, workspace: boolean,
): { messageId: string; username: string; source: TeammateInviteSource } | null {
  let asked = false;
  for (const message of messages) {
    const authorId = message.user_id || (typeof message.userId === 'string' ? message.userId : message.userId?._id);
    if (authorId === viewerId) { asked = true; continue; }
    if (!asked || message.author_kind === 'kernel' || message.message_type === 'system' || !message.content.trim()) continue;
    const author = message.user || (typeof message.userId === 'object' ? message.userId : undefined);
    const username = author?.username || '';
    const bot = typeof author?.isBot === 'boolean' ? author.isBot : agentKeys.has(username.toLowerCase());
    const metadata = (message as V2Message & { metadata?: { runFailed?: boolean } }).metadata;
    if (!bot || metadata?.runFailed) continue;
    // D288: in the person's own workspace only their own agent's answer counts.
    // Scout's doesn't, and the card there invites into a new pod, never this one.
    if (workspace && scoutKeys.has(username.toLowerCase())) continue;
    return {
      messageId: String(message.id), username,
      source: workspace ? 'workspace-own-agent' : 'first-agent-post',
    };
  }
  return null;
}
