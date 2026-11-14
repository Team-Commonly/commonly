import { useCallback, useEffect, useRef, useState } from 'react';
import { useV2Api } from './useV2Api';

interface ReadPointState {
  podId: string | null;
  lastReadAt: string | null;
  ready: boolean;
}

/**
 * First minute back: the viewer's read point in a pod's main channel, as it
 * stood when they opened the pod, and a writer that moves it forward. `ready`
 * turns true for that pod once the read answers or fails; a failure reads as
 * "no point", which opens the pod at its end as before.
 */
export const usePodReadPoint = (podId: string | null) => {
  const api = useV2Api();
  const [state, setState] = useState<ReadPointState>({ podId: null, lastReadAt: null, ready: false });
  const sentRef = useRef<{ podId: string | null; at: number }>({ podId: null, at: 0 });

  useEffect(() => {
    if (!podId) return undefined;
    let cancelled = false;
    setState({ podId, lastReadAt: null, ready: false });
    sentRef.current = { podId, at: 0 };
    api.get<{ lastReadAt?: string | null }>(`/api/pods/${encodeURIComponent(podId)}/read-point`)
      .then((data) => { if (!cancelled) setState({ podId, lastReadAt: data?.lastReadAt ?? null, ready: true }); })
      .catch(() => { if (!cancelled) setState({ podId, lastReadAt: null, ready: true }); });
    return () => { cancelled = true; };
  }, [api, podId]);

  // Moves the point to `at` when that is later than anything sent for this pod.
  const markRead = useCallback((at: string | null | undefined) => {
    const ms = at ? new Date(at).getTime() : NaN;
    if (!podId || !Number.isFinite(ms)) return;
    if (sentRef.current.podId === podId && ms <= sentRef.current.at) return;
    sentRef.current = { podId, at: ms };
    api.put(`/api/pods/${encodeURIComponent(podId)}/read-point`, { at: new Date(ms).toISOString() }).catch(() => {
      // Let the next look at the end try again.
      if (sentRef.current.podId === podId && sentRef.current.at === ms) sentRef.current = { podId, at: 0 };
    });
  }, [api, podId]);

  const ready = state.ready && state.podId === podId;
  return { ready, lastReadAt: ready ? state.lastReadAt : null, markRead };
};
