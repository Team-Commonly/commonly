/**
 * One summarizer run a minute per Discord row, shared by `/summary` (F161) and
 * its legacy twin `/discord-push` (F162). Both run the same LLM call, so a
 * channel that alternates them must not get twice the rate.
 *
 * Claimed before the run, so two calls racing in the same second still make
 * one. Per process: a second replica keeps its own clock, which at worst
 * doubles the rate, never removes the limit.
 */
export const SUMMARY_COOLDOWN_MS = 60_000;

export const SUMMARY_COOLING = 'A summary ran here less than a minute ago. Try again shortly.';

const summaryRanAt = new Map<string, number>();

/** True when this row may run now; it then holds the slot for a minute. */
export const claimSummaryRun = (rowId: unknown): boolean => {
  const key = String(rowId);
  const now = Date.now();
  const last = summaryRanAt.get(key);
  if (last !== undefined && now - last < SUMMARY_COOLDOWN_MS) return false;
  summaryRanAt.set(key, now);
  // Drop expired entries so the map stays the size of the last minute's rows.
  summaryRanAt.forEach((at, id) => { if (now - at >= SUMMARY_COOLDOWN_MS) summaryRanAt.delete(id); });
  return true;
};

/** Test seam: forget every row's last run. */
export const resetSummaryCooldowns = (): void => { summaryRanAt.clear(); };
