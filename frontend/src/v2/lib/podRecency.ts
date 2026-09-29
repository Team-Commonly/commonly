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

// The mark is 22px with 11px mono characters, so two Han characters wrap to a
// second line inside the square — that is why a CJK pick is cut to one glyph.
//
// This is a SCRIPT list, so the rule it states is a CJK rule and not a width
// rule. JS `\p{…}` expresses General_Category, Script and binary properties but
// not East_Asian_Width, so `ＡＢ` (fullwidth Latin, EAW=Fullwidth) is out of
// scope by decision and shows both glyphs. The 22px sentence above is the
// motivation for the rule, not a contract this predicate can compute.
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Two-letter mark for a pod without an avatar: initials of the first two words,
// or the first two letters of a one-word name.
//
// Tokenising matches `initialsFor`: the same split, the same [^\p{L}\p{N}]
// strip and the same filter, so punctuation and dashes separate words instead
// of becoming initials and "Sharpen — pod model" is SP rather than S—. It does
// not copy initialsFor's parenthetical drop, deliberately: "(v2)" distinguishes
// a pod name even though "(lead)" never distinguishes an agent. An emoji drops
// out the way punctuation does, which is why "🚀 Launch" is LA rather than 🚀L. A
// name whose picked glyphs are CJK shows one glyph — "设计评审" is 设, not the
// two characters that would wrap. Code points rather than UTF-16 units
// throughout, so a surrogate pair is never cut in half.
export const podInitials = (name: string): string => {
  const words = String(name || '')
    .trim()
    .split(/[\s_\-/|]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return '·';

  const first = (word: string): string => Array.from(word)[0] || '';
  const pick = words.length === 1
    ? Array.from(words[0]).slice(0, 2).join('')
    : first(words[0]) + first(words[1]);

  const picked = Array.from(pick);
  if (picked.some((char) => CJK_SCRIPT.test(char))) return picked[0];
  return pick.toUpperCase();
};
