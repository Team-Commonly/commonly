import i18n, { i18nReady } from '../../../i18n';
import { appDateLocale } from '../appLocale';

describe('appDateLocale: dates follow the app language, not the browser', () => {
  beforeAll(async () => { await i18nReady; });
  afterEach(async () => { await i18n.changeLanguage('en'); });

  test('Chinese in any spelling formats as zh-CN', () => {
    for (const language of ['zh-CN', 'zh', 'zh-Hans', 'ZH-cn']) {
      expect(appDateLocale(language)).toBe('zh-CN');
    }
  });

  test('every other language returns undefined, the browser default, so English output is unchanged', () => {
    for (const language of ['en', 'en-US', 'fr', '', undefined]) {
      expect(appDateLocale(language)).toBeUndefined();
    }
  });

  test('with no argument it reads the live i18n language', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(appDateLocale()).toBe('zh-CN');
    await i18n.changeLanguage('en');
    expect(appDateLocale()).toBeUndefined();
  });

  test('a zh-CN date reads in Chinese order, and the English call is byte-identical to a call with no locale', () => {
    const at = new Date('2026-10-25T05:00:00Z');
    expect(at.toLocaleString(appDateLocale('zh-CN'))).toBe(at.toLocaleString('zh-CN'));
    expect(at.toLocaleDateString(appDateLocale('zh-CN'))).toMatch(/^2026\/10\/2[45]$/);
    expect(at.toLocaleString(appDateLocale('en'))).toBe(at.toLocaleString());
  });
});
