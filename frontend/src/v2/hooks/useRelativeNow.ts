import { useEffect, useState } from 'react';

/**
 * A `now` that advances once a minute, for surfaces that render relative
 * timestamps ("5m ago", "since 2h ago").
 *
 * Those labels are computed from `Date.now()` while React renders, so a page
 * that reads once and then sits still keeps the age it first drew — the
 * "last-update timestamp stays stale until a refresh" report behind TASK-131.
 * `V2PodsSidebar` already ticks its own clock on this cadence. Same cadence,
 * not one shared instance: each surface owns its interval and neither reads
 * the other's state, so what is shared is the rate at which `now` moves.
 *
 * Rendering only: this never reads the server. Source freshness is separate
 * and belongs to the visibility reload each surface owns.
 */
export const useRelativeNow = (intervalMs = 60_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
};

export default useRelativeNow;
