// Direction C sidebar: "Recent" is ordered by MY last visit, and every row shows
// the pod's last-message time. There is no per-member read cursor in the kernel
// yet (walk-1 ruling g, 2026-09-06), so the visit log lives in localStorage on
// this device until `lastReadAt` lands; the time column never depends on it.

export const POD_VISITS_KEY = 'v2:podVisits';
export const RECENT_LIMIT = 8;

export type PodVisits = Record<string, number>;

export const readPodVisits = (): PodVisits => {
  try {
    const raw = localStorage.getItem(POD_VISITS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: PodVisits = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([id, at]) => {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    });
    return out;
  } catch {
    return {};
  }
};

export const recordPodVisit = (podId: string, at: number = Date.now()): PodVisits => {
  const visits = { ...readPodVisits(), [podId]: at };
  try {
    localStorage.setItem(POD_VISITS_KEY, JSON.stringify(visits));
  } catch {
    // Storage unavailable: Recent falls back to last-message order.
  }
  return visits;
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// Compact mono time for a 260px row: one number and one unit, never a date.
// "now" under a minute so a live pod never reads "0m".
export const relativeTime = (value: string | number | Date | null | undefined, now: number = Date.now()): string => {
  if (value === null || value === undefined) return '';
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(at)) return '';
  const delta = Math.max(0, now - at);
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}w`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo`;
  return `${Math.floor(delta / YEAR)}y`;
};

// Two-letter mark for a pod without an avatar: initials of the first two words,
// or the first two letters of a one-word name.
export const podInitials = (name: string): string => {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
};
