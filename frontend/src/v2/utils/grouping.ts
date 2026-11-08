import { calendarLocale, compactYesterday } from './compactTime';

const startOfDay = (d: Date): number => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
};

export const formatRelativeTime = (raw: string | Date | undefined): string => {
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const today = startOfDay(now);
  const ts = date.getTime();
  if (ts >= today) {
    return date.toLocaleTimeString(calendarLocale(), { hour: 'numeric', minute: '2-digit' });
  }
  if (ts >= today - 24 * 60 * 60 * 1000) {
    return compactYesterday();
  }
  if (ts >= today - 6 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString(calendarLocale(), { weekday: 'short' });
  }
  return date.toLocaleDateString(calendarLocale(), { month: 'short', day: 'numeric' });
};
