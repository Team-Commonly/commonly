import { V2Message } from '../hooks/useV2PodDetail';
import { V2ThreadState } from '../hooks/useV2ThreadState';
import { V2ThreadParticipant } from '../components/V2ThreadCard';

/**
 * Fold a flat message list into the threaded render order (W-T 4/4).
 *
 * Pure, and separate from V2PodChat, because this is the part with the edge
 * cases and the component is 1,300 lines of surface. Everything here is
 * decided from data the server sent: `thread_root_id` on each message and the
 * per-root state from #1145. Nothing is derived from timestamps.
 */
export type ThreadViewItem =
  | { kind: 'message'; message: V2Message }
  | {
    kind: 'card';
    rootId: string;
    replyCount: number;
    participants: V2ThreadParticipant[];
    lastActivityAt: string | null;
    replies: V2Message[];
  };

const idOf = (m: V2Message): string => String(m.id);
const rootOf = (m: V2Message): string | null => (
  m.thread_root_id === null || m.thread_root_id === undefined ? null : String(m.thread_root_id)
);
const whenOf = (m: V2Message): string => String(m.created_at || m.createdAt || '');

const participantOf = (m: V2Message): V2ThreadParticipant => {
  const uid = String(m.user_id || '');
  const nested = typeof m.userId === 'object' && m.userId ? m.userId : undefined;
  return {
    userId: uid,
    name: m.user?.username || nested?.username || uid,
    avatarUrl: m.user?.profile_picture ?? nested?.profilePicture ?? null,
    isBot: typeof m.user?.isBot === 'boolean' ? m.user.isBot : nested?.isBot,
  };
};

export const buildThreadView = (
  messages: V2Message[],
  byRoot: Map<string, V2ThreadState>,
): ThreadViewItem[] => {
  const repliesByRoot = new Map<string, V2Message[]>();
  for (const m of messages) {
    const root = rootOf(m);
    if (!root) continue;
    // A message whose root is not in this list (paged out, or deleted) is NOT
    // hidden. It renders flat rather than vanishing — losing a message is the
    // one outcome worse than showing it in the wrong place.
    if (!messages.some((x) => idOf(x) === root)) continue;
    const bucket = repliesByRoot.get(root);
    if (bucket) bucket.push(m);
    else repliesByRoot.set(root, [m]);
  }

  const out: ThreadViewItem[] = [];
  for (const m of messages) {
    const root = rootOf(m);
    if (root && repliesByRoot.has(root)) continue; // rendered under its card

    out.push({ kind: 'message', message: m });

    const replies = repliesByRoot.get(idOf(m));
    if (!replies || replies.length === 0) continue;

    // Participants in first-appearance order, deduped, root author included:
    // they started it and their face belongs on the card.
    const seen = new Set<string>();
    const participants: V2ThreadParticipant[] = [];
    for (const p of [m, ...replies]) {
      const uid = String(p.user_id || '');
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      participants.push(participantOf(p));
    }

    const lastActivityAt = replies.reduce<string>(
      (acc, r) => (whenOf(r) > acc ? whenOf(r) : acc),
      whenOf(m),
    ) || null;

    out.push({
      kind: 'card',
      rootId: idOf(m),
      replyCount: replies.length,
      participants,
      lastActivityAt,
      replies,
    });
  }
  return out;
};

export default buildThreadView;
