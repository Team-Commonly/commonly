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
});
