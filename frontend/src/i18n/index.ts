import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export const LANGUAGE_STORAGE_KEY = 'v2.lang';
export const SUPPORTED_LANGUAGES = ['en', 'zh-CN'] as const;

const setDocumentLanguage = (language: string): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language === 'zh-CN' ? 'zh-CN' : 'en';
};

export const i18nReady = i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
    },
    supportedLngs: [...SUPPORTED_LANGUAGES],
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    },
  })
  .then(() => setDocumentLanguage(i18n.resolvedLanguage || i18n.language));

void i18nReady;

i18n.on('languageChanged', setDocumentLanguage);

export default i18n;
