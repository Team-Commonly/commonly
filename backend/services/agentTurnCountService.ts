/**
 * F669: how many turns a person's own agent ran today and in the last seven
 * days, for its owner. A turn is one spawn the agent's runner reported
 * (AgentRuntimeObservation.recentTurns, written by agentRuntimeObservation), so
 * this counts what ran on the owner's Claude or Codex account. The health page
 * counts events, and the runner folds several events into one spawn, so events
 * overstate it.
 *
 * Days are the owner's local days (`User.timezone`, UTC when unset). "The last
 * seven days" is today and the six local days before it, a rolling window,
 * not a calendar week.
 */
import { RECENT_TURN_LIMIT } from '../models/AgentRuntimeObservation';

const WINDOW_DAYS = 7;

type Turn = { podId?: string | null; at: Date | string };
export type PodTurnCount = { podId: string | null; today: number; week: number };
export type TurnCounts = { today: number; week: number; weekCapped: boolean; pods: PodTurnCount[] };

// The local dates of today and the six days before it. Stepped on the calendar,
// not in 24-hour steps from now, so a day that a DST change makes 23 or 25
// hours long is neither skipped nor counted twice.
const windowDates = (today: string): Set<string> => {
  const [year, month, day] = today.split('-').map(Number);
  return new Set(Array.from({ length: WINDOW_DAYS }, (_unused, back) => (
    new Date(Date.UTC(year, month - 1, day - back)).toISOString().slice(0, 10)
  )));
};

/**
 * Today's and the last seven days' turns in `timeZone`, in total and per pod.
 * `weekCapped` is true when the stored list is full and its oldest turn is
 * still inside the window: older turns in the window were dropped, so the
 * seven-day count is a floor, not a total.
 */
export const turnCounts = (turns: Turn[], timeZone: string, now: Date = new Date()): TurnCounts => {
  // One formatter for the whole list: building one per turn costs ~25 µs each.
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const localDate = (at: Date) => format.format(at);
  const today = localDate(now);
  const window = windowDates(today);
  const byPod = new Map<string | null, PodTurnCount>();
  const totals = { today: 0, week: 0 };
  let oldestInWindow = false;
  turns.forEach((turn, index) => {
    const at = new Date(turn.at);
    if (Number.isNaN(at.getTime()) || at > now) return;
    const date = localDate(at);
    if (!window.has(date)) return;
    if (index === 0) oldestInWindow = true;
    const podId = turn.podId || null;
    const pod = byPod.get(podId) || { podId, today: 0, week: 0 };
    pod.week += 1;
    totals.week += 1;
    if (date === today) {
      pod.today += 1;
      totals.today += 1;
    }
    byPod.set(podId, pod);
  });
  return {
    ...totals,
    weekCapped: turns.length >= RECENT_TURN_LIMIT && oldestInWindow,
    pods: [...byPod.values()].sort((a, b) => b.week - a.week || b.today - a.today),
  };
};

// CJS compat: consumed from both `import` and `require()` call sites.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports; Object.assign(module.exports, exports);
