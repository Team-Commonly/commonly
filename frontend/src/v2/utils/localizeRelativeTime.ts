import type { TFunction } from 'i18next';

export interface RelativeTimeOptions {
  /** Keep future timestamps as "from now"; past-only surfaces clamp to now. */
  includeFuture?: boolean;
  /** Text for a missing or invalid timestamp. */
  missing?: string;
  /** Preserve each surface's established boundary behavior. */
  rounding?: 'floor' | 'round';
}

/** Keep the compact relative-time grammar shared by the connector surfaces. */
export const relativeTime = (
  date?: string | null,
  { includeFuture = true, missing = '—', rounding = 'round' }: RelativeTimeOptions = {},
): string => {
  if (!date) return missing;
  const timestamp = new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return missing;
  const elapsed = Date.now() - timestamp;
  const signedElapsed = includeFuture ? elapsed : Math.max(0, elapsed);
  const future = signedElapsed < 0;
  const abs = Math.abs(signedElapsed);
  const round = rounding === 'floor' ? Math.floor : Math.round;
  const minutes = round(abs / 60_000);
  if (minutes < 1) return future ? 'in a moment' : 'just now';
  const suffix = future ? 'from now' : 'ago';
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = round(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  return `${round(hours / 24)}d ${suffix}`;
};

/** Render relative time through the single locale family used by both pages. */
export const localizeRelativeTime = (
  date: string | null | undefined,
  t: TFunction,
  options: RelativeTimeOptions = {},
): string => {
  const raw = relativeTime(date, options);
  const missing = options.missing ?? '—';
  if (raw === 'just now') return t('time.justNow', { defaultValue: 'just now' });
  if (raw === 'in a moment') return t('time.inAMoment', { defaultValue: 'in a moment' });
  if (raw === missing || raw === '—') return raw;
  const match = raw.match(/^(\d+)([mhd]) (ago|from now)$/);
  if (!match) return raw;
  const [, countText, unit, direction] = match;
  const unitName = unit === 'm' ? 'minutes' : unit === 'h' ? 'hours' : 'days';
  const key = `${unitName}${direction === 'ago' ? 'Ago' : 'FromNow'}`;
  return t(`time.${key}`, {
    count: Number(countText),
    defaultValue: `${countText}${unit} ${direction}`,
  });
};
