import { formatDistanceToNow } from 'date-fns';

export const toValidDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const getTimeMs = (value, fallback = 0) => {
  const date = toValidDate(value);
  return date ? date.getTime() : fallback;
};

export const formatDistanceToNowSafe = (
  value,
  options = {},
  fallback = 'recently',
) => {
  const date = toValidDate(value);
  if (!date) return fallback;
  try {
    return formatDistanceToNow(date, options);
  } catch (error) {
    return fallback;
  }
};
