import { useCallback, useEffect, useRef, useState } from 'react';
import { useV2Api } from './useV2Api';

export interface V2AttentionItem {
  id: string;
  kind: 'mention' | 'approval' | 'decision' | 'handoff';
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
export const ATTENTION_CHANGED = 'v2:attention-changed';
export const notifyAttentionChanged = () => window.dispatchEvent(new Event(ATTENTION_CHANGED));

export const useV2PodAttention = (enabled = true) => {
  const api = useV2Api();
  const apiRef = useRef(api);
  apiRef.current = api;
  const [items, setItems] = useState<V2AttentionItem[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [countByPod, setCountByPod] = useState<Record<string, number>>({});
  const [countByKind, setCountByKind] = useState<Record<string, number>>({});
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++generation.current;
    try {
      const data = await apiRef.current.get<{ items: V2AttentionItem[]; count: number; countsByPod: Record<string, number>; countsByKind?: Record<string, number> }>('/api/activity/decision-queue');
      if (request !== generation.current) return;
      if (!Array.isArray(data?.items) || typeof data.count !== 'number' || !data.countsByPod) throw new Error('Invalid attention queue');
      setItems(data.items);
      setCount(data.count);
      setCountByPod(data.countsByPod);
      setCountByKind(data.countsByKind || {});
    } catch {
      // Attention is additive UI. A transient read failure must not invent a
      // stale count or block the pod surface; the next refresh retries it.
      if (request !== generation.current) return;
      setItems([]);
      setCount(null);
      setCountByPod({});
      setCountByKind({});
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
    window.addEventListener(ATTENTION_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      generation.current += 1;
      window.removeEventListener(ATTENTION_CHANGED, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return { items, count, countByPod, countByKind, refresh };
};
