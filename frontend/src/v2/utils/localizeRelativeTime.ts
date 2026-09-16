import type { TFunction } from 'i18next';

export interface RelativeTimeOptions {
  /** Keep future timestamps as "from now"; past-only surfaces clamp to now. */
  includeFuture?: boolean;
  /** Text for a missing or invalid timestamp. */
  missing?: string;
  /** Preserve each surface's established boundary behavior. */
  rounding?: 'floor' | 'round';
}

export type RelativeParts =
  | { kind: 'missing' }
  | { kind: 'now'; future: boolean }
  | { kind: 'rel'; unit: 'minute' | 'hour' | 'day'; count: number; future: boolean };

/** Compute relative-time semantics once so every formatter consumes the same parts. */
export const relativeParts = (
  date?: string | null,
  { includeFuture = true, rounding = 'round' }: RelativeTimeOptions = {},
): RelativeParts => {
  if (!date) return { kind: 'missing' };
  const timestamp = new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return { kind: 'missing' };
  const elapsed = Date.now() - timestamp;
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

const formatRelativeParts = (parts: RelativeParts, missing: string): string => {
  if (parts.kind === 'missing') return missing;
  if (parts.kind === 'now') return parts.future ? 'in a moment' : 'just now';
  const unit = parts.unit[0];
  return `${parts.count}${unit} ${parts.future ? 'from now' : 'ago'}`;
};

/** Keep the compact English grammar shared by the connector surfaces. */
export const relativeTime = (
  date?: string | null,
  options: RelativeTimeOptions = {},
): string => formatRelativeParts(relativeParts(date, options), options.missing ?? '—');

/** Render relative time through the single locale family used by both pages. */
export const localizeRelativeTime = (
  date: string | null | undefined,
  t: TFunction,
  options: RelativeTimeOptions = {},
): string => {
  const parts = relativeParts(date, options);
  const missing = options.missing ?? '—';
  if (parts.kind === 'missing') return missing;
  if (parts.kind === 'now') {
    return t(`time.${parts.future ? 'inAMoment' : 'justNow'}`, {
      defaultValue: formatRelativeParts(parts, missing),
    });
  }
  const key = `time.${parts.unit}s${parts.future ? 'FromNow' : 'Ago'}`;
  return t(key, {
    count: parts.count,
    defaultValue: formatRelativeParts(parts, missing),
  });
};
