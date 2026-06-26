const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const absDiffMs = Math.abs(diffMs);

  if (absDiffMs < MINUTE_MS) return 'Just now';
  if (absDiffMs < HOUR_MS) return `${Math.round(absDiffMs / MINUTE_MS)}m`;
  if (absDiffMs < DAY_MS) return `${Math.round(absDiffMs / HOUR_MS)}h`;

  const now = new Date();
  const input = new Date(date);
  const isYesterday =
    now.getFullYear() === input.getFullYear() &&
    now.getMonth() === input.getMonth() &&
    now.getDate() - input.getDate() === 1;

  if (isYesterday) return 'Yesterday';

  return `${Math.round(absDiffMs / DAY_MS)}d`;
}

export default formatRelativeTime;
