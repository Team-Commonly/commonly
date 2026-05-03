import { useCallback, useEffect, useState } from 'react';
import { useV2Api } from './useV2Api';

export interface V2PodMember {
  _id?: string;
  username?: string;
  profilePicture?: string | null;
  isBot?: boolean;
}

export interface V2PodLastMessage {
  content: string;
  createdAt: string;
  username: string | null;
}

export interface V2Pod {
  _id: string;
  name: string;
  description?: string;
  type?: string;
  joinPolicy?: string;
  members?: (V2PodMember | string)[];
  createdBy?: { _id?: string; username?: string };
  createdAt?: string;
  updatedAt?: string;
  lastMessage?: V2PodLastMessage | null;
}

export interface UseV2PodsResult {
  pods: V2Pod[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createPod: (name: string, description?: string, type?: 'team' | 'chat') => Promise<V2Pod | null>;
  deletePod: (podId: string) => Promise<boolean>;
  patchLastMessage: (podId: string, last: V2PodLastMessage) => void;
}

export const useV2Pods = (): UseV2PodsResult => {
  const api = useV2Api();
  const [pods, setPods] = useState<V2Pod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<V2Pod[]>('/api/pods');
      setPods(Array.isArray(data) ? data : []);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; msg?: string } }; message?: string };
      setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Failed to load pods');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const createPod = useCallback(async (
    name: string,
    description?: string,
    type: 'team' | 'chat' = 'team',
  ): Promise<V2Pod | null> => {
    try {
      const pod = await api.post<V2Pod>('/api/pods', {
        name,
        description: description || '',
        type,
        joinPolicy: 'open',
      });
      setPods((prev) => [pod, ...prev]);
      return pod;
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; msg?: string } }; message?: string };
      setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Failed to create pod');
      return null;
    }
  }, [api]);

  const patchLastMessage = useCallback((podId: string, last: V2PodLastMessage) => {
    if (!podId || !last) return;
    setPods((prev) => {
      const idx = prev.findIndex((p) => p._id === podId);
      if (idx < 0) return prev;
      const existing = prev[idx];
      const existingTs = existing.lastMessage?.createdAt
        ? new Date(existing.lastMessage.createdAt).getTime()
        : 0;
      const incomingTs = last.createdAt ? new Date(last.createdAt).getTime() : 0;
      // Only patch when strictly newer — avoids overwriting an in-place
      // optimistic message with an older socket event of the same row.
      if (incomingTs && existingTs && incomingTs <= existingTs) return prev;
      const next = prev.slice();
      next[idx] = {
        ...existing,
        lastMessage: last,
        updatedAt: last.createdAt || existing.updatedAt,
      };
      return next;
    });
  }, []);

  const deletePod = useCallback(async (podId: string): Promise<boolean> => {
    if (!podId) return false;
    try {
      await api.del(`/api/pods/${podId}`);
      setPods((prev) => prev.filter((pod) => pod._id !== podId));
      return true;
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; msg?: string } }; message?: string };
      setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Failed to delete pod');
      return false;
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { pods, loading, error, refresh, createPod, deletePod, patchLastMessage };
};
