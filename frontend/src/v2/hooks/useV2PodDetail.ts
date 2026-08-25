import { useCallback, useEffect, useState } from 'react';
import { useV2Api } from './useV2Api';
import { V2Pod, V2PodMember } from './useV2Pods';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';

export interface V2Message {
  id: string;
  pod_id: string;
  user_id: string;
  content: string;
  message_type: string;
  created_at: string;
  createdAt?: string;
  messageType?: string;
  user?: {
    username: string;
    profile_picture?: string | null;
    // Face-vs-robot avatar tier. The PG SELECT always fetched u.is_bot; the
    // backend mapper now forwards it instead of dropping it.
    isBot?: boolean;
  };
  userId?: string | {
    _id?: string;
    username?: string;
    profilePicture?: string | null;
    isBot?: boolean;
  };
  // Reply threading (PG reply_to_message_id). POST/GET responses carry either
  // the normalized `replyTo` object or the raw reply_* columns; the bubble
  // renders whichever is present.
  replyTo?: { id: string; content: string; username: string; userId?: string } | null;
  // Threading (PG thread_root_id, #1106). Present on every message the PG
  // reads return; null on a root and on anything predating the backfill.
  // Distinct from reply_to_message_id ON PURPOSE — that one is ADDRESSING and
  // wakes the parent's author, this one is membership and wakes nobody.
  thread_root_id?: number | string | null;
  reply_msg_id?: string | null;
  reply_content?: string | null;
  reply_username?: string | null;
  // Sender-only delivery feedback. Present on POST responses for regular
  // pods; omitted for DM-shaped pods and older backends.
  agentDelivery?: {
    enqueued: number;
    implicit: string[];
    agentsInPod: number;
    // Wake-on-message targets (#914). Optional: older backends omit it.
    woken?: number;
  };
  // Sprint B5: per-message reactions, aggregated server-side.
  // Each entry is `{emoji, count, mine, users?}` — `users` is the
  // Google-Chat-style attribution list decorated by
  // backend/services/reactionAttributionService (resolves bot
  // displayName via agentIdentityService.resolveAgentDisplayLabel).
  // Absent in legacy fixtures + on Mongo fallback; bubbles fall back
  // to the token-parsed `[[reactions:...]]` shape if so. Older servers
  // omit `users` entirely — tooltips degrade to count-only.
  reactions?: Array<{
    emoji: string;
    count: number;
    mine: boolean;
    users?: Array<{ id: string; username: string; displayName?: string }>;
  }>;
  // ADR-020 D3: structured component payload. `kind` discriminates renderers
  // (approval-card first). Server-composed; survives normalizeMessage via
  // the `...raw` spread — declared here so consumers can read it typed.
  payload?: {
    kind?: string;
    approvalId?: string;
    actionType?: string;
    summary?: string;
    params?: Record<string, unknown>;
    status?: string;
    decision?: string;
    ownerUserId?: string;
    agentName?: string;
    expiresAt?: string;
    executionResult?: { podId?: string; podName?: string } | Record<string, unknown>;
    executionError?: string;
  } | null;
}

export interface V2Agent {
  agentName: string;
  instanceId?: string;
  displayName?: string;
  iconUrl?: string;
  status?: string;
  lastHeartbeatAt?: string | null;
  // Role family — resolved server-side from the agent's preset
  // (Development, Design, Strategy, Marketing, Research, etc.). Renders
  // as a small chip in the inspector and powers the Your Team filters.
  // Null for agents installed without a known preset.
  category?: string | null;
  runtime?: {
    // Identity-bearing runtime tag — codex / claude-code / openclaw /
    // moltbot / webhook / internal / local-cli (legacy).
    runtimeType?: string;
    // 'cloud' (Commonly-managed) or 'byo' (user runs the agent themselves
    // — ADR-005 local CLI, future user-server, etc.). Cloud is the default
    // for built-ins. Server-side normalization fills this from
    // sanitizeRuntimeConfig — frontend can trust either field's presence.
    host?: 'cloud' | 'byo';
    // Legacy CLI shape (pre-2026-05-04). Backend normalizes to runtimeType
    // + host:'byo' on read; kept here for defense-in-depth in case an
    // older backend serves an unmigrated payload.
    wrappedCli?: string;
  } | null;
  profile?: {
    purpose?: string;
    persona?: { tone?: string; specialties?: string[] };
    avatarUrl?: string;
    iconUrl?: string;
    displayName?: string;
  };
}

interface AgentsResponse {
  agents: V2Agent[];
}

interface MessagesResponse {
  // The API returns either a normalized array or a Mongo array; we type it loosely.
  data?: V2Message[];
}

export interface UseV2PodDetailResult {
  pod: V2Pod | null;
  members: V2PodMember[];
  messages: V2Message[];
  agents: V2Agent[];
  loading: boolean;
  error: string | null;
  /** Send failures belong beside the composer; load failures use `error`. */
  sendError: string | null;
  /** A full page came back, so older history probably exists. */
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  refresh: () => Promise<void>;
  // `threadRootId` posts INTO a thread without addressing anyone: the backend
  // takes it as membership and leaves reply_to null, so joining a thread does
  // not ping the root's author (@ux-lead 56879, resolver in #1128).
  //
  // Passing both is a caller bug, but NOT one the backend catches: the
  // resolver 400s the pair only when they DISAGREE, and returns happily when
  // a reply edge and an explicit root point at the same thread. Keeping them
  // exclusive is therefore the client's job and nothing downstream will
  // notice if it stops.
  sendMessage: (
    content: string,
    messageType?: string,
    replyToMessageId?: string,
    threadRootId?: string,
  ) => Promise<V2Message | null>;
}

const REQUEST_TIMEOUT_MS = 8000;
const SEND_TIMEOUT_MS = 20000;
// One page of history. The backend clamps `limit` to [1,200]; 50 matches the
// showcase reader so both surfaces page at the same rate.
const PAGE_SIZE = 50;

// Merge two message lists by id, newest-last. Used when prepending a page of
// history: a plain concat would duplicate anything the socket delivered while
// the request was in flight.
const mergeMessagesById = (a: V2Message[], b: V2Message[]): V2Message[] => {
  const byId = new Map<string, V2Message>();
  for (const m of a) byId.set(String(m.id), m);
  for (const m of b) byId.set(String(m.id), m);
  return chronologicalMessages([...byId.values()]);
};

const normalizeMessage = (raw: V2Message): V2Message => {
  const rawUserId = raw.userId;
  const userObject = typeof rawUserId === 'object' && rawUserId !== null ? rawUserId : null;
  const username = raw.user?.username || userObject?.username || 'Unknown';
  const profilePicture = raw.user?.profile_picture || userObject?.profilePicture || null;
  const isBot = raw.user?.isBot ?? userObject?.isBot;
  return {
    ...raw,
    id: raw.id || (raw as { _id?: string })._id || '',
    pod_id: raw.pod_id || (raw as { podId?: string }).podId || '',
    user_id: raw.user_id || (typeof rawUserId === 'string' ? rawUserId : userObject?._id) || '',
    message_type: raw.message_type || raw.messageType || 'text',
    created_at: raw.created_at || raw.createdAt || new Date().toISOString(),
    content: raw.content || (raw as { text?: string }).text || '',
    user: {
      username,
      profile_picture: profilePicture,
      // Absent on old cached payloads and some socket shapes — undefined means
      // "unknown", and V2Avatar renders the neutral tier for unknown rather
      // than guessing a species.
      ...(isBot === undefined ? {} : { isBot }),
    },
  };
};

const chronologicalMessages = (messages: V2Message[]): V2Message[] => (
  [...messages].sort((a, b) => (
    new Date(a.created_at || a.createdAt || 0).getTime()
    - new Date(b.created_at || b.createdAt || 0).getTime()
  ))
);

// `emitReactionChange` computes `mine` for the user who triggered the change and
// broadcasts that single view to the whole room — so every OTHER client gets a
// wrong `mine`, which flips the add/remove toggle (clicking your own reaction
// re-adds instead of removing) and mis-highlights chips (2026-07-24). Recompute
// `mine` for THIS client from each reaction's user list; fall back to the wire
// value only when `users` is absent (older server / Mongo fallback path).
export const recomputeReactionMine = <T extends { mine: boolean; users?: Array<{ id: string }> }>(
  reactions: T[],
  userId: string | undefined | null,
): T[] => reactions.map((r) => ({
  ...r,
  mine: Array.isArray(r.users) && userId
    ? r.users.some((u) => String(u.id) === String(userId))
    : r.mine,
}));

export const useV2PodDetail = (podId: string | null): UseV2PodDetailResult => {
  const api = useV2Api();
  const { socket, connected, joinPod, leavePod } = useSocket();
  const { currentUser } = useAuth();
  const [pod, setPod] = useState<V2Pod | null>(null);
  const [messages, setMessages] = useState<V2Message[]>([]);
  const [agents, setAgents] = useState<V2Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const fetchPod = useCallback(async (id: string) => {
    const result = await api.get<V2Pod>(`/api/pods/${id}`, { timeout: REQUEST_TIMEOUT_MS });
    setPod(result);
  }, [api]);

  const fetchMessages = useCallback(async (id: string) => {
    try {
      const data = await api.get<V2Message[]>(
        `/api/messages/${id}?limit=${PAGE_SIZE}`,
        { timeout: REQUEST_TIMEOUT_MS },
      );
      const list = Array.isArray(data) ? data : [];
      setMessages(chronologicalMessages(list.map(normalizeMessage)));
      // This endpoint returns a bare array with no envelope, so end-of-history
      // is inferred: a short page means there is nothing older behind it.
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      const e = err as { response?: { status?: number } };
      if (e.response?.status === 404) {
        setMessages([]);
        setHasMore(false);
      } else throw err;
    }
  }, [api]);

  /**
   * Prepend one page of older history.
   *
   * Anchors on the oldest message currently held and asks for everything
   * strictly before it (`before` is already supported server-side and is the
   * same cursor the showcase reader uses). Results are merged by id rather
   * than concatenated, because the socket may have delivered messages while
   * the request was in flight.
   */
  const loadOlder = useCallback(async () => {
    if (!podId || loadingOlder) return;
    const oldest = messages[0];
    if (!oldest) return;
    const cursor = oldest.created_at || oldest.createdAt;
    if (!cursor) return;

    setLoadingOlder(true);
    try {
      const data = await api.get<V2Message[]>(
        `/api/messages/${podId}?limit=${PAGE_SIZE}&before=${encodeURIComponent(cursor)}`,
        { timeout: REQUEST_TIMEOUT_MS },
      );
      const older = (Array.isArray(data) ? data : []).map(normalizeMessage);
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      setMessages((prev) => mergeMessagesById(older, prev));
      setHasMore(older.length >= PAGE_SIZE);
    } catch {
      // Leave hasMore alone so the same button can be retried.
    } finally {
      setLoadingOlder(false);
    }
  }, [api, podId, messages, loadingOlder]);

  const fetchAgents = useCallback(async (id: string) => {
    try {
      const data = await api.get<AgentsResponse>(`/api/registry/pods/${id}/agents`, { timeout: REQUEST_TIMEOUT_MS });
      // Registry returns each agent with `name` (e.g. "openclaw"), but the
      // V2Agent contract is `agentName`. Normalize at the boundary so every
      // downstream consumer (including the "Talk to" POST body) gets a
      // populated agentName instead of silently sending undefined.
      const raw = Array.isArray(data?.agents) ? data.agents : [];
      const normalized = raw.map((a: V2Agent & { name?: string }) => ({
        ...a,
        agentName: a.agentName || a.name || '',
      }));
      setAgents(normalized);
    } catch {
      setAgents([]);
    }
  }, [api]);

  const refresh = useCallback(async () => {
    if (!podId) {
      setPod(null);
      setMessages([]);
      setAgents([]);
      setSendError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setSendError(null);
    try {
      await fetchPod(podId);
      const [messagesResult] = await Promise.allSettled([
        fetchMessages(podId),
        fetchAgents(podId),
      ]);
      if (messagesResult.status === 'rejected') {
        setMessages([]);
        const e = messagesResult.reason as { response?: { status?: number; data?: { error?: string; msg?: string } }; message?: string };
        const status = e.response?.status;
        if (status === 401 || status === 403) {
          // Friendlier soft state — backend's raw "Not authorized to view
          // messages in this pod" reads like a security warning. For a
          // non-member browsing a shared pod link, "You're not a member"
          // is the truer framing.
          setError("You're not a member of this pod, so messages aren't visible.");
        } else {
          setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Messages are taking too long to load');
        }
      }
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: string; msg?: string } }; message?: string };
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        setError("You're not a member of this pod.");
      } else {
        setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Failed to load pod');
      }
    } finally {
      setLoading(false);
    }
  }, [podId, fetchPod, fetchMessages, fetchAgents]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!podId || !socket || !connected) return undefined;
    joinPod(podId);
    const handleNewMessage = (raw: V2Message) => {
      const normalized = normalizeMessage(raw);
      if (normalized.pod_id && normalized.pod_id !== podId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id && m.id === normalized.id)) return prev;
        return chronologicalMessages([...prev, normalized]);
      });
    };
    // Sprint B5: socket-driven reaction updates. Backend emits
    // `messageReaction` with the new aggregated list after every add/remove
    // by any user. We patch only the matching message's `reactions` array
    // — no other state churn.
    const handleReactionChange = (payload: { messageId: string; podId?: string; reactions: Array<{ emoji: string; count: number; mine: boolean; users?: Array<{ id: string; username: string; displayName?: string }> }> }) => {
      if (!payload || !payload.messageId) return;
      if (payload.podId && payload.podId !== podId) return;
      // `emitReactionChange` computes `mine` for the user who triggered the
      // change and broadcasts that single view to the whole room. Trusting it
      // gives every OTHER client a wrong `mine` — which flips the add/remove
      // toggle (clicking your own reaction re-adds instead of removing) and
      // mis-highlights chips. Recompute `mine` for THIS client from the
      // reaction's user list (2026-07-24). Fall back to the wire value only
      // when `users` is absent (older server / Mongo fallback).
      const reactions = recomputeReactionMine(payload.reactions, currentUser?._id);
      setMessages((prev) => prev.map((m) => (
        String(m.id) === String(payload.messageId)
          ? { ...m, reactions }
          : m
      )));
    };
    // ADR-020 D3: card status transitions. Same patch discipline as
    // reactions — one field on one message; the server's payload is
    // authoritative (card faces are shared state, never per-viewer).
    const handleCardUpdate = (update: { messageId: string; podId?: string; payload?: V2Message['payload'] }) => {
      if (!update || !update.messageId) return;
      if (update.podId && update.podId !== podId) return;
      setMessages((prev) => prev.map((m) => (
        String(m.id) === String(update.messageId)
          ? { ...m, payload: update.payload }
          : m
      )));
    };
    socket.on('newMessage', handleNewMessage);
    socket.on('messageReaction', handleReactionChange);
    socket.on('messageCardUpdated', handleCardUpdate);
    return () => {
      socket.off('newMessage', handleNewMessage);
      socket.off('messageReaction', handleReactionChange);
      socket.off('messageCardUpdated', handleCardUpdate);
      leavePod(podId);
    };
  }, [podId, socket, connected, joinPod, leavePod, currentUser?._id]);

  const sendMessage = useCallback(async (
    content: string,
    messageType = 'text',
    replyToMessageId?: string,
    threadRootId?: string,
  ): Promise<V2Message | null> => {
    if (!podId || !content.trim()) return null;
    try {
      setSendError(null);
      const created = await api.post<V2Message>(
        `/api/messages/${podId}`,
        {
          content: content.trim(),
          messageType,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(threadRootId ? { threadRootId } : {}),
        },
        { timeout: SEND_TIMEOUT_MS },
      );
      const normalized = normalizeMessage(created);
      // Dedupe by id — the Socket.io `newMessage` broadcast and this
      // optimistic add both come from the same DB row and race after
      // backend PR #304 (which added the user-message broadcast). Whichever
      // arrives first wins; the second is a no-op. Without this, sending
      // a message renders it twice in the sender's tab. When the socket copy
      // won the race, still graft this POST copy's reply fields onto it —
      // an older backend's broadcast omits replyTo, which dropped the reply
      // quote until reload (#646).
      setMessages((prev) => {
        if (prev.some((m) => m.id && m.id === normalized.id)) {
          return prev.map((m) => (
            m.id === normalized.id
              ? {
                ...m,
                replyTo: m.replyTo ?? normalized.replyTo ?? null,
                // #646's graft, one field over: when the socket copy wins
                // the race and lacks the thread root (older server), keep
                // the POST copy's — or the sender's own in-thread reply
                // renders top-level until refresh (Sam, 2026-08-24).
                thread_root_id: m.thread_root_id ?? normalized.thread_root_id ?? null,
              }
              : m
          ));
        }
        return chronologicalMessages([...prev, normalized]);
      });
      return normalized;
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; msg?: string } }; message?: string };
      setSendError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Failed to send message');
      return null;
    }
  }, [api, podId]);

  const members: V2PodMember[] = (pod?.members || []).filter(
    (m): m is V2PodMember => typeof m === 'object' && m !== null,
  );

  return {
    pod, members, messages, agents, loading, error, sendError, hasMore, loadingOlder, loadOlder, refresh, sendMessage,
  };
};

// Suppress unused import warning when MessagesResponse is not used below.
export type { MessagesResponse };
