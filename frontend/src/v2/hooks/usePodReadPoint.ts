import { useCallback, useEffect, useRef, useState } from 'react';
import { useV2Api } from './useV2Api';

export const READ_POINT_PUT_WINDOW_MS = 10_000;

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
  // A busy pod reaches its end on every arrival. One PUT per window carries
  // the latest point, so the PUTs stay well inside the route's rate limit.
  const throttleRef = useRef<{ lastPutAt: number; timer: ReturnType<typeof setTimeout> | null; flush: (() => void) | null }>(
    { lastPutAt: 0, timer: null, flush: null },
  );

  useEffect(() => {
    if (!podId) return undefined;
    let cancelled = false;
    setState({ podId, lastReadAt: null, ready: false });
    sentRef.current = { podId, at: 0 };
    throttleRef.current.lastPutAt = 0;
    api.get<{ lastReadAt?: string | null }>(`/api/pods/${encodeURIComponent(podId)}/read-point`)
      .then((data) => { if (!cancelled) setState({ podId, lastReadAt: data?.lastReadAt ?? null, ready: true }); })
      .catch(() => { if (!cancelled) setState({ podId, lastReadAt: null, ready: true }); });
    return () => {
      cancelled = true;
      // Leaving the pod sends the point a pending window was holding.
      const pending = throttleRef.current;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
      pending.flush?.();
      pending.flush = null;
    };
  }, [api, podId]);

  // Moves the point to `at` when that is later than anything sent for this pod.
  const markRead = useCallback((at: string | null | undefined) => {
    const ms = at ? new Date(at).getTime() : NaN;
    if (!podId || !Number.isFinite(ms)) return;
    if (sentRef.current.podId === podId && ms <= sentRef.current.at) return;
    sentRef.current = { podId, at: ms };
    const throttle = throttleRef.current;
    const send = () => {
      throttle.flush = null;
      throttle.lastPutAt = Date.now();
      const latest = sentRef.current.podId === podId ? sentRef.current.at : ms;
      api.put(`/api/pods/${encodeURIComponent(podId)}/read-point`, { at: new Date(latest).toISOString() }).catch(() => {
        // Let the next look at the end try again.
        if (sentRef.current.podId === podId && sentRef.current.at === latest) sentRef.current = { podId, at: 0 };
      });
    };
    if (throttle.timer) { throttle.flush = send; return; }
    const wait = throttle.lastPutAt + READ_POINT_PUT_WINDOW_MS - Date.now();
    if (wait <= 0) { send(); return; }
    throttle.flush = send;
    throttle.timer = setTimeout(() => {
      throttle.timer = null;
      throttle.flush?.();
    }, wait);
  }, [api, podId]);

  const ready = state.ready && state.podId === podId;
  return { ready, lastReadAt: ready ? state.lastReadAt : null, markRead };
};
