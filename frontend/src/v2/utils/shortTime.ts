import { compactAge, compactNow, compactYesterday } from './compactTime';

/**
 * Short-form "last activity" for the thread card (W-T 4/4).
 *
 * The brief asks for `2m / 1h / Yesterday`. Deliberately NOT a general
 * relative-time helper: it is the card's one line, where the whole budget is a
 * few characters and precision past the unit is noise.
 *
 * `now` is injected rather than read from the clock so the tests can be about
 * the boundaries instead of about timing. A helper that reads Date.now()
 * internally can only be tested loosely, and the boundaries are the part that
 * has an off-by-one in it.
 *
 * The words come from `time.compact.*` in the active app language (zh-CN:
 * 刚刚 / 5分钟 / 3小时 / 昨天 / 2天 / 1周); the boundaries are the same in every
 * language.
 */
export const shortTimeSince = (
  raw: string | Date | undefined | null,
  now: Date = new Date(),
): string => {
  if (!raw) return '';
  const then = raw instanceof Date ? raw : new Date(raw);
  const ms = then.getTime();
  if (Number.isNaN(ms)) return '';

  const diffMs = now.getTime() - ms;
  // A clock skew between server and browser can put "last activity" slightly
  // in the future. Render that as "now" rather than a negative age.
  if (diffMs < 0) return compactNow();

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return compactNow();
  if (minutes < 60) return compactAge('minute', minutes);

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return compactAge('hour', hours);

  // Calendar-day comparison, not a 48h window: "Yesterday" means the previous
  // date, so 23:00 yesterday read at 01:00 today is Yesterday and not "2h".
  // (2h wins on the hours branch above, which is correct — this branch only
  // sees ages past a day.)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (ms >= startOfYesterday.getTime()) return compactYesterday();

  const days = Math.floor(hours / 24);
  if (days < 7) return compactAge('day', days);
  return compactAge('week', Math.floor(days / 7));
};

export default shortTimeSince;
