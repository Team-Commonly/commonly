import { useCallback, useEffect, useMemo, useState } from 'react';
import { useV2Api } from './useV2Api';

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Per-user thread state for one pod (W-T, TASK-029 4/4).
 *
 * `collapsed` arrives ALREADY RESOLVED — docs/design/threading-surface-ruling.md,
 * § "One state record, two booleans" (@ux-lead, pod 56996). Shipped in
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
  toggleFollowing: (messageId: string) => void;
}

const key = (id: number | string) => String(id);

export const useV2ThreadState = (podId: string | undefined): UseV2ThreadState => {
  const api = useV2Api();
  const [byRoot, setByRoot] = useState<Map<string, V2ThreadState>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
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
      })
      .catch(() => {
        // Degrade to "no threads known", which renders every message flat —
        // the pre-threading view. Never invent collapsed:true on a failure:
        // that would hide replies the user could see a moment ago, and they
        // would have no way to tell a fetch failure from an empty pod.
        if (!cancelled) setByRoot(new Map());
      })
      .finally(() => { if (!cancelled) setLoading(false); });
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

  const isThreadRoot = useCallback(
    (messageId: string) => byRoot.has(key(messageId)),
    [byRoot],
  );

  return useMemo(
    () => ({ byRoot, loading, isThreadRoot, toggleCollapsed, toggleFollowing }),
    [byRoot, loading, isThreadRoot, toggleCollapsed, toggleFollowing],
  );
};

export default useV2ThreadState;
