import i18n from '../../i18n';

/**
 * The compact age vocabulary every mono time column shares: now / 5m / 3h /
 * Yesterday / 2d / 1w / 1mo / 1y, rendered through `time.compact.*` in the
 * active app language.
 *
 * Words only, never boundaries. Each caller keeps its own cut-offs (Activity
 * stops at days, Artifacts rolls to months at 30 days, the pod list runs to
 * years), so the English each one produced before stays byte-identical. One
 * literal key per unit so the migration manifest can check every one.
 *
 * Reads the i18n instance rather than taking `t`: the callers are plain
 * helpers, and the components that render them already re-render on a
 * language change through their own useTranslation().
 */
export type CompactUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export const compactNow = (): string => i18n.t('time.compact.now', { defaultValue: 'now' });

export const compactYesterday = (): string => i18n.t('time.compact.yesterday', { defaultValue: 'Yesterday' });

export const compactAge = (unit: CompactUnit, n: number): string => {
  switch (unit) {
    case 'minute': return i18n.t('time.compact.minutes', { n, defaultValue: '{{n}}m' });
    case 'hour': return i18n.t('time.compact.hours', { n, defaultValue: '{{n}}h' });
    case 'day': return i18n.t('time.compact.days', { n, defaultValue: '{{n}}d' });
    case 'week': return i18n.t('time.compact.weeks', { n, defaultValue: '{{n}}w' });
    case 'month': return i18n.t('time.compact.months', { n, defaultValue: '{{n}}mo' });
    default: return i18n.t('time.compact.years', { n, defaultValue: '{{n}}y' });
  }
};

/**
 * The locale for calendar formatting (clock times, weekdays, month-day).
 * A non-English app language wins, so a zh-CN reader on an English browser
 * gets 周日, not Sun. English keeps the browser's own regional English
 * (`undefined`), so an en-GB reader still sees 15:05 and 3 Nov exactly as
 * before this followed the app language.
 */
export const calendarLocale = (): string | undefined => {
  const language = i18n.resolvedLanguage || i18n.language;
  return !language || language === 'en' || language.startsWith('en-') ? undefined : language;
};
