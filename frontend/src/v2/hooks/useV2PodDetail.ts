import { useCallback, useEffect, useState } from 'react';
import { useV2Api } from './useV2Api';
import { V2Pod, V2PodMember } from './useV2Pods';
import { useSocket } from '../../context/SocketContext';

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
  };
  userId?: string | {
    _id?: string;
    username?: string;
    profilePicture?: string | null;
  };
}

export interface V2Agent {
  agentName: string;
  instanceId?: string;
  displayName?: string;
  iconUrl?: string;
  status?: string;
  lastHeartbeatAt?: string | null;
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
  refresh: () => Promise<void>;
  sendMessage: (content: string, messageType?: string) => Promise<V2Message | null>;
}

const REQUEST_TIMEOUT_MS = 8000;
const SEND_TIMEOUT_MS = 20000;

const normalizeMessage = (raw: V2Message): V2Message => {
  const rawUserId = raw.userId;
  const userObject = typeof rawUserId === 'object' && rawUserId !== null ? rawUserId : null;
  const username = raw.user?.username || userObject?.username || 'Unknown';
  const profilePicture = raw.user?.profile_picture || userObject?.profilePicture || null;
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
    },
  };
};

const chronologicalMessages = (messages: V2Message[]): V2Message[] => (
  [...messages].sort((a, b) => (
    new Date(a.created_at || a.createdAt || 0).getTime()
    - new Date(b.created_at || b.createdAt || 0).getTime()
  ))
);

export const useV2PodDetail = (podId: string | null): UseV2PodDetailResult => {
  const api = useV2Api();
  const { socket, connected, joinPod, leavePod } = useSocket();
  const [pod, setPod] = useState<V2Pod | null>(null);
  const [messages, setMessages] = useState<V2Message[]>([]);
  const [agents, setAgents] = useState<V2Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPod = useCallback(async (id: string) => {
    const result = await api.get<V2Pod>(`/api/pods/${id}`, { timeout: REQUEST_TIMEOUT_MS });
    setPod(result);
  }, [api]);

  const fetchMessages = useCallback(async (id: string) => {
    try {
      const data = await api.get<V2Message[]>(`/api/messages/${id}?limit=50`, { timeout: REQUEST_TIMEOUT_MS });
      const list = Array.isArray(data) ? data : [];
      setMessages(chronologicalMessages(list.map(normalizeMessage)));
    } catch (err) {
      const e = err as { response?: { status?: number } };
      if (e.response?.status === 404) setMessages([]);
      else throw err;
    }
  }, [api]);

  const fetchAgents = useCallback(async (id: string) => {
    try {
      const data = await api.get<AgentsResponse>(`/api/registry/pods/${id}/agents`, { timeout: REQUEST_TIMEOUT_MS });
      setAgents(Array.isArray(data?.agents) ? data.agents : []);
    } catch {
      setAgents([]);
    }
  }, [api]);

  const refresh = useCallback(async () => {
    if (!podId) {
      setPod(null);
      setMessages([]);
      setAgents([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await fetchPod(podId);
      const [messagesResult] = await Promise.allSettled([
        fetchMessages(podId),
        fetchAgents(podId),
      ]);
      if (messagesResult.status === 'rejected') {
        setMessages([]);
        const e = messagesResult.reason as { response?: { data?: { error?: string; msg?: string } }; message?: string };
        setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Messages are taking too long to load');
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; msg?: string } }; message?: string };
      setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Failed to load pod');
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
    socket.on('newMessage', handleNewMessage);
    return () => {
      socket.off('newMessage', handleNewMessage);
      leavePod(podId);
    };
  }, [podId, socket, connected, joinPod, leavePod]);

  const sendMessage = useCallback(async (content: string, messageType = 'text'): Promise<V2Message | null> => {
    if (!podId || !content.trim()) return null;
    try {
      setError(null);
      const created = await api.post<V2Message>(
        `/api/messages/${podId}`,
        { content: content.trim(), messageType },
        { timeout: SEND_TIMEOUT_MS },
      );
      const normalized = normalizeMessage(created);
      setMessages((prev) => chronologicalMessages([...prev, normalized]));
      return normalized;
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; msg?: string } }; message?: string };
      setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Failed to send message');
      return null;
    }
  }, [api, podId]);

  const members: V2PodMember[] = (pod?.members || []).filter(
    (m): m is V2PodMember => typeof m === 'object' && m !== null,
  );

  return { pod, members, messages, agents, loading, error, refresh, sendMessage };
};

// Suppress unused import warning when MessagesResponse is not used below.
export type { MessagesResponse };
