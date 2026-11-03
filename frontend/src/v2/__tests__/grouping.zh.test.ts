import i18n, { i18nReady } from '../../i18n';
import { formatRelativeTime } from '../utils/grouping';

// formatRelativeTime follows the APP language, not the browser's: jsdom's
// default locale is English, so before this a zh-CN reader saw "Sun".
describe('formatRelativeTime follows the app language', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  test('zh-CN: weekday, yesterday and clock time are Chinese', async () => {
    await i18nReady;
    await i18n.changeLanguage('zh-CN');
    expect(formatRelativeTime(daysAgo(3))).toMatch(/^周[一二三四五六日]$/);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    expect(formatRelativeTime(yesterday)).toBe('昨天');
    expect(formatRelativeTime(new Date())).not.toMatch(/AM|PM/);
    expect(formatRelativeTime(daysAgo(40))).toMatch(/^\d{1,2}月\d{1,2}日$/);
  });

  test('English keeps the browser default formatting', async () => {
    await i18nReady;
    const at = daysAgo(3);
    expect(formatRelativeTime(at)).toBe(at.toLocaleDateString([], { weekday: 'short' }));
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    expect(formatRelativeTime(yesterday)).toBe('Yesterday');
  });
});
