import type { TFunction } from 'i18next';

export interface RelativeTimeOptions {
  /** Keep future timestamps as "from now"; past-only surfaces clamp to now. */
  includeFuture?: boolean;
  /** Text for a missing or invalid timestamp. */
  missing?: string;
  /** Preserve each surface's established boundary behavior. */
  rounding?: 'floor' | 'round';
  /** The render's clock. Callers that decide what a render SHOWS pass their `now`. */
  now?: number;
}

export type RelativeParts =
  | { kind: 'missing' }
  | { kind: 'now'; future: boolean }
  | { kind: 'rel'; unit: 'minute' | 'hour' | 'day'; count: number; future: boolean };

/** Compute relative-time semantics once so every formatter consumes the same parts. */
export const relativeParts = (
  date?: string | null,
  { includeFuture = true, rounding = 'round', now = Date.now() }: RelativeTimeOptions = {},
): RelativeParts => {
  if (!date) return { kind: 'missing' };
  const timestamp = new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return { kind: 'missing' };
  const elapsed = now - timestamp;
  const signedElapsed = includeFuture ? elapsed : Math.max(0, elapsed);
  const future = signedElapsed < 0;
  const abs = Math.abs(signedElapsed);
  const round = rounding === 'floor' ? Math.floor : Math.round;
  const minutes = round(abs / 60_000);
  if (minutes < 1) return { kind: 'now', future };
  if (minutes < 60) return { kind: 'rel', unit: 'minute', count: minutes, future };
  const hours = round(minutes / 60);
  if (hours < 24) return { kind: 'rel', unit: 'hour', count: hours, future };
  return { kind: 'rel', unit: 'day', count: round(hours / 24), future };
};

/** Keep the compact English grammar shared by the connector surfaces. */
const formatRelativeParts = (parts: RelativeParts, missing: string): string => {
  if (parts.kind === 'missing') return missing;
  if (parts.kind === 'now') return parts.future ? 'in a moment' : 'just now';
  const unit = parts.unit[0];
  return `${parts.count}${unit} ${parts.future ? 'from now' : 'ago'}`;
};

/**
 * The English string alone, for surfaces that are not localized (and as the
 * `defaultValue` fallback). Grammar is unchanged from the two per-component
 * helpers this replaced.
 */
export const relativeTime = (
  date?: string | null,
  options: RelativeTimeOptions = {},
): string => formatRelativeParts(relativeParts(date, options), options.missing ?? '—');

/**
 * The same parts, rendered through the `time.age.*` keys both connector
 * surfaces already share ("2小时前", "刚刚"). A key per unit and direction, so
 * every one is a literal the migration manifest can enforce.
 */
export const localizeRelativeTime = (
  date: string | null | undefined,
  t: TFunction,
  options: RelativeTimeOptions = {},
): string => {
  const parts = relativeParts(date, options);
  const missing = options.missing ?? '—';
  const fallback = formatRelativeParts(parts, missing);
  if (parts.kind === 'missing') {
    return missing === 'just now' ? t('time.age.justNow', { defaultValue: missing }) : missing;
  }
  if (parts.kind === 'now') {
    return parts.future
      ? t('time.age.inAMoment', { defaultValue: fallback })
      : t('time.age.justNow', { defaultValue: fallback });
  }
  const n = parts.count;
  switch (parts.unit) {
    case 'minute':
      return parts.future
        ? t('time.age.minutesFromNow', { n, defaultValue: fallback })
        : t('time.age.minutesAgo', { n, defaultValue: fallback });
    case 'hour':
      return parts.future
        ? t('time.age.hoursFromNow', { n, defaultValue: fallback })
        : t('time.age.hoursAgo', { n, defaultValue: fallback });
    default:
      return parts.future
        ? t('time.age.daysFromNow', { n, defaultValue: fallback })
        : t('time.age.daysAgo', { n, defaultValue: fallback });
  }
};

/**
 * A budget window as a localized duration ("1h" / "1小时"). Reuses the age
 * family's unit strings: a window is an age with the direction dropped.
 */
export const localizeWindow = (windowMs: number, t: TFunction): string => {
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  if (minutes < 60) return t('time.age.minutes', { defaultValue: '{{n}}m', n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.age.hours', { defaultValue: '{{n}}h', n: hours });
  return t('time.age.days', { defaultValue: '{{n}}d', n: Math.round(hours / 24) });
};
