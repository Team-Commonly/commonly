import { PlaybookError } from './definition';

export interface PlaybookSchedule { cron: string; timezone: string }
interface LocalMinute { date: string; weekday: number; hour: number; minute: number }
const MINUTE = 60_000;

const formatter = (timezone: string) => new Intl.DateTimeFormat('en-US', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export const validateSchedule = (input: unknown): PlaybookSchedule => {
  const value = input as Partial<PlaybookSchedule> | null;
  if (!value || typeof value.cron !== 'string' || typeof value.timezone !== 'string'
    || Object.keys(value).some((field) => !['cron', 'timezone'].includes(field))
    || !/^(?:[0-9]|[1-5][0-9]) (?:[0-9]|1[0-9]|2[0-3]) \* \* (?:\*|1-5|[0-6])$/.test(value.cron)) {
    throw new PlaybookError('invalid_schedule', 'Choose daily, weekdays or one weekday at HH:MM', 400);
  }
  try { formatter(value.timezone).format(new Date()); } catch {
    throw new PlaybookError('invalid_timezone', 'Choose an IANA timezone', 400);
  }
  return { cron: value.cron, timezone: value.timezone };
};

const localMinute = (format: Intl.DateTimeFormat, at: number): LocalMinute => {
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) };
};

/** A repeated hour has one logical slot; a skipped time falls on the first minute after the gap. */
export const latestScheduleSlot = (input: unknown, onAt: Date, now = new Date()): {
  key: string; at: Date; label: string;
} | null => {
  const schedule = validateSchedule(input);
  const [minute, hour, , , weekday] = schedule.cron.split(' ');
  const intended = Number(hour) * 60 + Number(minute);
  const format = formatter(schedule.timezone);
  const latest = Math.floor(now.getTime() / MINUTE) * MINUTE;
  for (let at = latest; at > now.getTime() - 60 * MINUTE; at -= MINUTE) {
    const current = localMinute(format, at);
    if (weekday !== '*' && (weekday === '1-5'
      ? current.weekday < 1 || current.weekday > 5 : current.weekday !== Number(weekday))) continue;
    const local = current.hour * 60 + current.minute;
    const previous = localMinute(format, at - MINUTE);
    const localStamp = Date.parse(current.date) / MINUTE + local;
    const previousStamp = Date.parse(previous.date) / MINUTE + previous.hour * 60 + previous.minute;
    const intendedStamp = Date.parse(current.date) / MINUTE + intended;
    const skipped = localStamp > previousStamp + 1
      && intendedStamp > previousStamp && intendedStamp < localStamp;
    if (local !== intended && !skipped) continue;
    // If this is the second copy of a repeated hour, the slot's actual age and
    // activation boundary are determined by its FIRST occurrence.
    let firstAt = at;
    if (!skipped) {
      for (let earlier = at - MINUTE; earlier >= at - 3 * 60 * MINUTE; earlier -= MINUTE) {
        const candidate = localMinute(format, earlier);
        if (candidate.date === current.date && candidate.hour * 60 + candidate.minute === intended) firstAt = earlier;
      }
    }
    if (firstAt <= onAt.getTime() || now.getTime() - firstAt >= 60 * MINUTE) continue;
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    return { key: `schedule:${current.date}T${time}`, at: new Date(firstAt),
      label: `Scheduled · ${current.date} ${time} (${schedule.timezone}) · not instant` };
  }
  return null;
};
