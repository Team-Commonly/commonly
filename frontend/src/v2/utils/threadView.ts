import { V2Message } from '../hooks/useV2PodDetail';
import { V2ThreadState } from '../hooks/useV2ThreadState';
import { V2ThreadParticipant } from '../components/V2ThreadCard';

/**
 * Fold a flat message list into the threaded render order (W-T 4/4).
 *
 * Pure, and separate from V2Thread, because this is the part with the edge
 * cases and the component is 1,300 lines of surface. Everything here is
 * decided from data the server sent: `thread_root_id` on each message and the
 * per-root state from #1145. Nothing is derived from timestamps.
 */
export type ThreadViewItem =
  | { kind: 'message'; message: V2Message }
  | { kind: 'claims'; key: string; messages: V2Message[] }
  | {
    kind: 'card';
    rootId: string;
    replyCount: number;
    participants: V2ThreadParticipant[];
    lastActivityAt: string | null;
    replies: V2Message[];
    /** D278: the newest reply, for the chip's one-line preview. */
    latestReply?: ThreadLatestReply | null;
    /** Replies the viewer hasn't read. 0 when they have no read point. */
    unreadCount?: number;
    /** Of those, the ones an agent wrote, and when the newest of them landed (ms). */
    unreadAgentCount?: number;
    newestUnreadAgentAt?: number | null;
    /** When the newest agent reply landed (ms), read or not. */
    newestAgentReplyAt?: number | null;
    /** The viewer wrote the root. */
    viewerIsRootAuthor?: boolean;
  };

export interface ThreadLatestReply {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  isBot?: boolean;
  /** One line of plain text. Empty for a card with no summary: the chip says "sent a card". */
  text: string;
  isCard: boolean;
}

/** What buildThreadView needs to know about the person reading. */
export interface ThreadViewer {
  viewerId?: string | null;
  /** The viewer's read point per root id (useV2ThreadState.readPoints). */
  readPoints?: ReadonlyMap<string, string>;
}

const idOf = (m: V2Message): string => String(m.id);
const rootOf = (m: V2Message): string | null => (
  m.thread_root_id === null || m.thread_root_id === undefined ? null : String(m.thread_root_id)
);
const whenOf = (m: V2Message): string => String(m.created_at || m.createdAt || '');
const isClaimLine = (m: V2Message): boolean => (
  (m.message_type === 'system' || m.messageType === 'system')
  && m.payload?.kind === 'system-action'
  && m.payload.action === 'task-claimed'
);

/**
 * Collapse each run of two or more consecutive claim lines into one summary
 * item. A claim that roots a thread stays a message so its card still renders,
 * and any other item ends the run, so only adjacent claims fold together.
 */
const groupClaimRuns = (items: ThreadViewItem[]): ThreadViewItem[] => {
  const out: ThreadViewItem[] = [];
  let run: V2Message[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: 'claims', key: idOf(run[0]), messages: run });
    else run.forEach((message) => out.push({ kind: 'message', message }));
    run = [];
  };
  items.forEach((item, index) => {
    if (item.kind === 'message' && isClaimLine(item.message) && items[index + 1]?.kind !== 'card') {
      run.push(item.message);
      return;
    }
    flush();
    out.push(item);
  });
  flush();
  return out;
};

/**
 * Keep replies that were visible before their root arrived flat for the life
 * of this transcript. A history prepend can otherwise make the same reply
 * move into a resting thread chip and disappear from the reader's viewport.
 */
export const freezeOrphanReplyIds = (
  messages: V2Message[],
  frozen: ReadonlySet<string> = new Set(),
): Set<string> => {
  const next = new Set(frozen);
  const presentIds = new Set(messages.map(idOf));
  for (const message of messages) {
    const root = rootOf(message);
    if (root && !presentIds.has(root)) next.add(idOf(message));
  }
  return next;
};

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

const timeOf = (m: V2Message): number => {
  const at = Date.parse(whenOf(m));
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
};

// Payload kinds that render as a card rather than as their content
// (V2MessageRow). Their content is not a sentence a preview can quote.
const CARD_PAYLOAD_KINDS = new Set(['approval-card', 'byo-handoff', 'ui', 'gig-card']);
const PREVIEW_MAX_CHARS = 200;

/**
 * One line of plain text from a message's markdown, for the thread chip.
 * Not a markdown parser: it removes the marks a preview would otherwise show
 * literally, keeps the words, and collapses every run of whitespace to one
 * space. The chip ellipsizes in CSS; the cap here only bounds the DOM.
 */
export const plainPreviewText = (content: string): string => String(content || '')
  .replace(/\[\[[a-z-]+:[^\]]*\]\]/gi, ' ') // [[reactions:…]]-style tokens
  .replace(/```[^\n]*\n?/g, ' ') // fence lines; the code inside stays
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
  .replace(/<[^>\n]+>/g, ' ') // inline html
  .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '') // headings, quotes, list marks
  .replace(/(\*\*|__|~~|`)/g, '')
  .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, '$1$2') // *em* / _em_
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, PREVIEW_MAX_CHARS);

/** The chip's preview of one reply: who, and one line of what they said. */
export const latestReplyPreview = (m: V2Message): ThreadLatestReply => {
  const who = participantOf(m);
  const summary = String(m.summary || m.payload?.summary || '').trim();
  const isCard = CARD_PAYLOAD_KINDS.has(String(m.payload?.kind || ''));
  const text = isCard
    ? plainPreviewText(summary)
    : plainPreviewText(m.content) || plainPreviewText(summary);
  return { ...who, text, isCard };
};

/**
 * The viewer's read point in one thread (D278), in ms, or null for none.
 *
 * The later of the server's `lastReadAt` and the viewer's own newest message
 * in the thread, the root included: writing in a thread means you saw what
 * came before. A thread they have never opened and never posted in has no
 * point, so it shows no unread mark — every old thread would otherwise light
 * up for people who were never in it.
 */
export const threadReadPoint = (
  root: V2Message,
  replies: V2Message[],
  viewerId: string | null | undefined,
  serverLastReadAt: string | null | undefined,
): number | null => {
  let point: number | null = null;
  const server = serverLastReadAt ? Date.parse(serverLastReadAt) : NaN;
  if (!Number.isNaN(server)) point = server;
  if (viewerId) {
    for (const m of [root, ...replies]) {
      if (String(m.user_id || '') !== String(viewerId)) continue;
      const at = timeOf(m);
      if (at !== Number.NEGATIVE_INFINITY && (point === null || at > point)) point = at;
    }
  }
  return point;
};

/** Replies another user wrote after the read point. None without a point. */
export const unreadRepliesOf = (
  replies: V2Message[],
  viewerId: string | null | undefined,
  readPoint: number | null,
): V2Message[] => {
  if (readPoint === null) return [];
  return replies.filter((r) => String(r.user_id || '') !== String(viewerId || '') && timeOf(r) > readPoint);
};

export const buildThreadView = (
  messages: V2Message[],
  byRoot: Map<string, V2ThreadState>,
  flatIds: ReadonlySet<string> = new Set(),
  viewer: ThreadViewer = {},
): ThreadViewItem[] => {
  // Ids up front. This used to be `messages.some(...)` inside the loop below,
  // which is O(n²) on a pod's whole scrollback — fine at 20 messages and not
  // at 2,000. @sprint-review on #1150.
  const presentIds = new Set(messages.map(idOf));

  const repliesByRoot = new Map<string, V2Message[]>();
  for (const m of messages) {
    const root = rootOf(m);
    if (!root) continue;
    if (flatIds.has(idOf(m))) continue;
    // A message whose root is not in this list (paged out, or deleted) is NOT
    // hidden. It renders flat rather than vanishing — losing a message is the
    // one outcome worse than showing it in the wrong place.
    if (!presentIds.has(root)) continue;
    const bucket = repliesByRoot.get(root);
    if (bucket) bucket.push(m);
    else repliesByRoot.set(root, [m]);
  }

  const out: ThreadViewItem[] = [];
  for (const m of messages) {
    const root = rootOf(m);
    if (root && repliesByRoot.has(root) && !flatIds.has(idOf(m))) continue; // rendered under its card

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

    // Newest by time; on a tie the later one in list order.
    const latest = replies.reduce((acc, r) => (timeOf(r) >= timeOf(acc) ? r : acc), replies[0]);
    const rootId = idOf(m);
    const serverPoint = viewer.readPoints?.get(rootId) ?? byRoot.get(rootId)?.lastReadAt ?? null;
    const readPoint = threadReadPoint(m, replies, viewer.viewerId, serverPoint);
    const unread = unreadRepliesOf(replies, viewer.viewerId, readPoint);
    const isAgent = (r: V2Message) => participantOf(r).isBot === true;
    const unreadAgent = unread.filter(isAgent);
    const newestOf = (list: V2Message[]) => (list.length
      ? list.reduce((acc, r) => Math.max(acc, timeOf(r)), Number.NEGATIVE_INFINITY)
      : null);

    out.push({
      kind: 'card',
      rootId,
      replyCount: replies.length,
      participants,
      lastActivityAt,
      replies,
      latestReply: latestReplyPreview(latest),
      unreadCount: unread.length,
      unreadAgentCount: unreadAgent.length,
      newestUnreadAgentAt: newestOf(unreadAgent),
      newestAgentReplyAt: newestOf(replies.filter(isAgent)),
      viewerIsRootAuthor: Boolean(viewer.viewerId) && String(m.user_id || '') === String(viewer.viewerId),
    });
  }
  return groupClaimRuns(out);
};
