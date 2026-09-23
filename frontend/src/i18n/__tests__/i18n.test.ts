import { act } from '@testing-library/react';
import i18n, { i18nReady, LANGUAGE_STORAGE_KEY } from '..';

describe('i18n configuration', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  beforeEach(async () => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  afterAll(async () => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await i18n.changeLanguage('en');
  });

  it('falls back to English when a zh-CN key is missing', () => {
    i18n.addResource('en', 'translation', 'test.fallbackOnly', 'English fallback');

    expect(i18n.t('test.fallbackOnly', { lng: 'zh-CN' })).toBe('English fallback');
  });

  it('defaults to English when no stored supported language exists', async () => {
    const languages = jest.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en-US']);
    const language = jest.spyOn(window.navigator, 'language', 'get').mockReturnValue('en-US');
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await act(async () => {
      await i18n.changeLanguage();
    });

    expect(i18n.resolvedLanguage).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    languages.mockRestore();
    language.mockRestore();
  });

  it('interpolates Phase 1B auth and invite chrome in both locales', () => {    expect(i18n.t('auth.oauth.continueWith', {
      lng: 'en',
      provider: 'GitHub',
    })).toBe('Continue with GitHub');
    expect(i18n.t('auth.oauth.continueWith', {
      lng: 'zh-CN',
      provider: 'GitHub',
    })).toBe('使用 GitHub 继续');
    expect(i18n.t('inviteRedeem.invitedTo', {
      lng: 'zh-CN',
      podName: 'Commonly HQ',
    })).toBe('你受邀加入 Commonly HQ');
  });

  it('keeps the verification copy glossary-clean in Simplified Chinese', () => {
    // lily-shen's zh-CN gate (2026-09-23, the eng lead's read under the
    // zh-cn-ui-localization skill, standing in for Sam's pass): "Pod" stays
    // English with half-width spaces, the purpose-clause calque 以…加入 is out,
    // and a Chinese sentence takes ，rather than an em dash. The banner and the
    // screen carry one sentence, so the two move together.
    const banner = i18n.t('auth.verificationBanner.message', { lng: 'zh-CN', email: 'new@example.com' });
    const screen = i18n.t('auth.register.success.checkEmailMessage', { lng: 'zh-CN', email: 'new@example.com' });

    expect(banner).toBe('验证邮箱后即可加入 Community Pod，链接已发送至 new@example.com。');
    expect(screen).toBe(banner);
    expect(i18n.t('auth.register.success.checkEmailTitle', { lng: 'zh-CN' })).toBe('欢迎加入');
    expect(`${banner}${screen}`).not.toMatch(/群组|—/);
  });
});
