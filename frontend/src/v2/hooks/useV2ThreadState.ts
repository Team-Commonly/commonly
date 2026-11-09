import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useV2Api } from './useV2Api';

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Per-user thread state for one pod (W-T, TASK-029 4/4).
 *
 * `collapsed` arrives ALREADY RESOLVED — @ux-lead's ruling (56996), shipped in
 * #1145. The server folds the explicit row and the pre-cutoff default into one
 * boolean per root, so this hook must never compute it. There is deliberately
 * no cutoff in the payload to compute it FROM: a client that could derive
 * `collapsed` would be carrying a migration detail forever.
 *
 * `following` is the opposite and stays raw: `true | false | null`, where null
 * means "defer to participation". The wake path resolves that against live
 * authorship; the render shows three states and never guesses which way null
 * would resolve.
 */
export interface V2ThreadState {
  threadRootId: number;
  following: boolean | null;
  collapsed: boolean;
  /**
   * My read point in this thread (D278): ISO, or null when I have never
   * opened it. Older servers omit it, which reads the same as null.
   */
  lastReadAt?: string | null;
}

interface ThreadStateResponse {
  podId: string;
  defaults: { following: boolean | null };
  threads: V2ThreadState[];
}

export interface UseV2ThreadState {
  byRoot: Map<string, V2ThreadState>;
  loading: boolean;
  /** Roots the server told us about — a message not in here is not a thread. */
  isThreadRoot: (messageId: string) => boolean;
  toggleCollapsed: (messageId: string) => void;
  /**
   * Write an explicit collapsed value. The transcript's resting state is the
   * chip (ux-lead 64476): every thread mounts collapsed and opening is a
   * session gesture, so the server row is brought to the visible state on
   * each open/close rather than blindly flipped.
   */
  setCollapsed: (messageId: string, collapsed: boolean) => void;
  toggleFollowing: (messageId: string) => void;
  /**
   * My read point per thread root: the server's `lastReadAt`, moved forward
   * by `markRead` in this session. Keyed by root id. Absent means never read.
   */
  readPoints: Map<string, string>;
  /**
   * Move my read point in a thread forward to `atIso`. Optimistic, and a
   * no-op when `atIso` is not newer than the point already known, so an open
   * thread can call it on every render without writing. Works for a thread
   * the state fetch never saw (one an answer created after mount): the server
   * resolves the root from any message id.
   */
  markRead: (rootId: string, atIso: string) => void;
  /** The state fetch has settled (loaded or failed) at least once for this pod. */
  ready: boolean;
}

const key = (id: number | string) => String(id);

export const useV2ThreadState = (podId: string | undefined): UseV2ThreadState => {
  const api = useV2Api();
  const [byRoot, setByRoot] = useState<Map<string, V2ThreadState>>(new Map());
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [readPoints, setReadPoints] = useState<Map<string, string>>(new Map());
  // The newest point known per root, read synchronously by markRead so two
  // calls in one tick don't both write. The state above is what renders.
  const readPointsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    // Reset without minting a new Map when there is nothing to clear. Every
    // new identity re-folds the transcript (V2Thread's threadView memo), and a
    // re-fold in the same commit as a landing reveal makes the landing effect
    // read the not-yet-opened thread as a history miss and page older history.
    if (readPointsRef.current.size > 0) {
      readPointsRef.current = new Map();
      setReadPoints(new Map());
    }
    setReady(false);
    if (!podId) {
      setByRoot(new Map());
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    api.get<ThreadStateResponse>(
      `/api/messages/threads/state?podId=${encodeURIComponent(podId)}`,
      { timeout: REQUEST_TIMEOUT_MS },
    )
      .then((data) => {
        if (cancelled) return;
        const next = new Map<string, V2ThreadState>();
        for (const t of data?.threads || []) next.set(key(t.threadRootId), t);
        setByRoot(next);
        // Server points merge under any this session already moved forward.
        // Same reason as the reset above: a new Map only when a point moved.
        const points = new Map(readPointsRef.current);
        let moved = false;
        for (const t of data?.threads || []) {
          const at = t.lastReadAt;
          if (!at || Number.isNaN(Date.parse(at))) continue;
          const known = points.get(key(t.threadRootId));
          if (!known || Date.parse(at) > Date.parse(known)) {
            points.set(key(t.threadRootId), at);
            moved = true;
          }
        }
        if (moved) {
          readPointsRef.current = points;
          setReadPoints(points);
        }
      })
      .catch(() => {
        // Degrade to "no threads known", which renders every message flat —
        // the pre-threading view. Never invent collapsed:true on a failure:
        // that would hide replies the user could see a moment ago, and they
        // would have no way to tell a fetch failure from an empty pod.
        if (!cancelled) setByRoot(new Map());
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setReady(true);
      });
    return () => { cancelled = true; };
  }, [api, podId]);

  const patch = useCallback((messageId: string, change: Partial<V2ThreadState>) => {
    setByRoot((prev) => {
      const row = prev.get(key(messageId));
      if (!row) return prev;
      const next = new Map(prev);
      next.set(key(messageId), { ...row, ...change });
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback((messageId: string) => {
    const row = byRoot.get(key(messageId));
    if (!row) return;
    const target = !row.collapsed;
    patch(messageId, { collapsed: target });
    api.put(`/api/messages/${messageId}/collapsed`, { collapsed: target })
      .catch(() => patch(messageId, { collapsed: row.collapsed }));
  }, [api, byRoot, patch]);

  const setCollapsed = useCallback((messageId: string, collapsed: boolean) => {
    const row = byRoot.get(key(messageId));
    if (!row || row.collapsed === collapsed) return;
    patch(messageId, { collapsed });
    api.put(`/api/messages/${messageId}/collapsed`, { collapsed })
      .catch(() => patch(messageId, { collapsed: row.collapsed }));
  }, [api, byRoot, patch]);

  const toggleFollowing = useCallback((messageId: string) => {
    const row = byRoot.get(key(messageId));
    if (!row) return;
    // Three states, two transitions, ONE column written either way — the
    // endpoints are separate precisely so a client cannot clobber `collapsed`
    // while touching follow. null and false both mean "start following".
    const target = row.following !== true;
    patch(messageId, { following: target });
    const revert = () => patch(messageId, { following: row.following });
    if (target) api.post(`/api/messages/${messageId}/follow`).catch(revert);
    else api.del(`/api/messages/${messageId}/follow`).catch(revert);
  }, [api, byRoot, patch]);

  const markRead = useCallback((rootId: string, atIso: string) => {
    const at = Date.parse(atIso);
    if (!rootId || Number.isNaN(at)) return;
    const known = readPointsRef.current.get(key(rootId));
    if (known && at <= Date.parse(known)) return;
    const next = new Map(readPointsRef.current);
    next.set(key(rootId), atIso);
    readPointsRef.current = next;
    setReadPoints(next);
    // Not reverted on failure. A read point is a convenience; putting the
    // unread mark back after the person has seen the replies would be the
    // worse error, and the next open writes again.
    api.put(`/api/messages/${encodeURIComponent(rootId)}/read`, { at: atIso }).catch(() => undefined);
  }, [api]);

  const isThreadRoot = useCallback(
    (messageId: string) => byRoot.has(key(messageId)),
    [byRoot],
  );

  return useMemo(
    () => ({
      byRoot, loading, isThreadRoot, toggleCollapsed, setCollapsed, toggleFollowing, readPoints, markRead, ready,
    }),
    [byRoot, loading, isThreadRoot, toggleCollapsed, setCollapsed, toggleFollowing, readPoints, markRead, ready],
  );
};
