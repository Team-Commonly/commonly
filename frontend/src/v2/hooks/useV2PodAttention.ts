import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useV2Api } from './useV2Api';

export interface V2AttentionItem {
  id: string;
  kind: 'mention' | 'approval' | 'decision';
  title: string;
  detail?: string;
  actorName?: string;
  podId: string | null;
  messageId?: string;
  threadRootId?: string;
}

/**
 * The workspace has one open-attention collection. Sidebar badges, the
 * inspector list, and the phone tab badge are views of this result, not
 * independently refreshed counters that can disagree.
 */
export const useV2PodAttention = () => {
  const api = useV2Api();
  const apiRef = useRef(api);
  apiRef.current = api;
  const [items, setItems] = useState<V2AttentionItem[]>([]);

  const refresh = useCallback(async () => {
    try {
      const data = await apiRef.current.get<{ items?: V2AttentionItem[] }>('/api/activity/decision-queue');
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch {
      // Attention is additive UI. A transient read failure must not invent a
      // stale count or block the pod surface; the next refresh retries it.
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const countByPod = useMemo(() => items.reduce<Record<string, number>>((counts, item) => {
    if (!item.podId) return counts;
    counts[item.podId] = (counts[item.podId] || 0) + 1;
    return counts;
  }, {}), [items]);

  return { items, countByPod, refresh };
};
