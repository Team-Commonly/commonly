import i18n from 'i18next';

/**
 * The locale a date or time should be formatted in: the app's language, not
 * the browser's. A person who picked 中文 in the app on an English browser
 * still saw "11/3/2026, 2:05:00 PM" wherever a call passed no locale.
 *
 * Chinese gets 'zh-CN'. Every other language returns `undefined`, the browser
 * default, so English output is exactly what it was before this helper.
 */
export const appDateLocale = (language: string | undefined = i18n.language): string | undefined => (
  (language || '').toLowerCase().startsWith('zh') ? 'zh-CN' : undefined
);
