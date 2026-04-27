import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'v2.pinnedPodIds';

const readStored = (): string[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
};

const writeStored = (ids: string[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage unavailable; pinning becomes session-only.
  }
};

export interface UseV2Pinned {
  pinned: Set<string>;
  isPinned: (id: string) => boolean;
  toggle: (id: string) => void;
}

export const useV2Pinned = (): UseV2Pinned => {
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(readStored()));

  useEffect(() => {
    writeStored(Array.from(pinned));
  }, [pinned]);

  const toggle = useCallback((id: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isPinned = useCallback((id: string) => pinned.has(id), [pinned]);

  return { pinned, isPinned, toggle };
};
