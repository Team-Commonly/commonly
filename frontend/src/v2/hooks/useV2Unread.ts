import { useCallback, useEffect, useState } from 'react';

// Per-pod "last seen" timestamp persisted to localStorage. We can't lean on
// the backend yet — there's no read-receipts model — so this is a frontend-
// only approximation: a row is "unread" when its latest message arrived
// after the user last had that pod selected. Survives reload, scoped per-
// browser, accepted limitation.

const STORAGE_KEY = 'v2.lastSeen';

const readMap = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
};

const writeMap = (map: Record<string, number>): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / private-mode errors */
  }
};

export interface UseV2UnreadResult {
  isUnread: (podId: string, lastMessageAt: string | undefined | null) => boolean;
  markRead: (podId: string) => void;
  // Bumps the perceived "latest message" timestamp for a pod without marking
  // it read. Used when a `newMessage` socket event lands while the pod is not
  // selected — keeps the unread badge sticky until the user actually opens
  // the pod, even if the server-side `lastMessage` field hasn't been refetched.
  bumpLatest: (podId: string, ts: string) => void;
}

export const useV2Unread = (selectedPodId: string | null): UseV2UnreadResult => {
  const [seenMap, setSeenMap] = useState<Record<string, number>>(() => readMap());
  const [latestMap, setLatestMap] = useState<Record<string, number>>({});

  // When the user navigates to a pod, mark it read. Persist to localStorage
  // so a refresh on the same pod stays read.
  useEffect(() => {
    if (!selectedPodId) return;
    const now = Date.now();
    setSeenMap((prev) => {
      const next = { ...prev, [selectedPodId]: now };
      writeMap(next);
      return next;
    });
  }, [selectedPodId]);

  const isUnread = useCallback((podId: string, lastMessageAt: string | undefined | null): boolean => {
    if (!podId || podId === selectedPodId) return false;
    const seen = seenMap[podId] || 0;
    const fromList = lastMessageAt ? new Date(lastMessageAt).getTime() : 0;
    const fromSocket = latestMap[podId] || 0;
    const latest = Math.max(fromList, fromSocket);
    return Number.isFinite(latest) && latest > seen;
  }, [seenMap, latestMap, selectedPodId]);

  const markRead = useCallback((podId: string) => {
    if (!podId) return;
    setSeenMap((prev) => {
      const next = { ...prev, [podId]: Date.now() };
      writeMap(next);
      return next;
    });
  }, []);

  const bumpLatest = useCallback((podId: string, ts: string) => {
    if (!podId || !ts) return;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return;
    setLatestMap((prev) => (prev[podId] && prev[podId] >= t ? prev : { ...prev, [podId]: t }));
  }, []);

  return { isUnread, markRead, bumpLatest };
};
