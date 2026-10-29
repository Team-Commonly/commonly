import { useEffect, useState } from 'react';

/**
 * The live star count on the landing page's GitHub links. The visitor's browser
 * asks GitHub's public API directly, so the count is cached for an hour and
 * there is no number at all when the request fails. Never a fallback number.
 */

export const REPO_API_URL = 'https://api.github.com/repos/Team-Commonly/commonly';
export const STAR_CACHE_KEY = 'v2.githubStars';
export const STAR_CACHE_MS = 60 * 60 * 1000;

type StarCacheEntry = { count: number; at: number };

const browserStorage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    // Some browsers throw on access when storage is blocked.
    return undefined;
  }
};

export function readStarCache(storage: Storage | undefined, now: number): number | null {
  try {
    const raw = storage?.getItem(STAR_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<StarCacheEntry>;
    if (typeof entry.count !== 'number' || typeof entry.at !== 'number') return null;
    // An entry from the future means the clock moved; treat it as stale.
    const age = now - entry.at;
    if (age < 0 || age > STAR_CACHE_MS) return null;
    return entry.count;
  } catch {
    return null;
  }
}

export function writeStarCache(storage: Storage | undefined, count: number, now: number): void {
  try {
    storage?.setItem(STAR_CACHE_KEY, JSON.stringify({ count, at: now } satisfies StarCacheEntry));
  } catch {
    // Unwritable storage only costs a refetch next visit.
  }
}

export async function fetchStarCount(
  request: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<number | null> {
  try {
    const res = await request(REPO_API_URL);
    if (!res.ok) return null;
    const body = (await res.json()) as { stargazers_count?: unknown };
    const count = body.stargazers_count;
    return typeof count === 'number' && Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

export function formatStarCount(count: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

/** The live count, or null while loading and whenever the count is unavailable. */
export function useGithubStarCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const storage = browserStorage();
    const cached = readStarCache(storage, Date.now());
    if (cached !== null) {
      setCount(cached);
      return undefined;
    }
    fetchStarCount().then((fresh) => {
      if (cancelled || fresh === null) return;
      writeStarCache(storage, fresh, Date.now());
      setCount(fresh);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return count;
}
