import { formatDistanceToNow } from 'date-fns';

type FormatDistanceToNowOptions = Parameters<typeof formatDistanceToNow>[1];

export const toValidDate = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const getTimeMs = (value: unknown, fallback = 0): number => {
  const date = toValidDate(value);
  return date ? date.getTime() : fallback;
};

export const formatDistanceToNowSafe = (
  value: unknown,
  options: FormatDistanceToNowOptions = {},
  fallback = 'recently',
): string => {
  const date = toValidDate(value);
  if (!date) return fallback;
  try {
    return formatDistanceToNow(date, options);
  } catch (_error) {
    return fallback;
  }
};
