import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export const LANGUAGE_STORAGE_KEY = 'v2.lang';
// Self-labels let readers find their language regardless of the active locale.
export const LANGUAGE_REGISTRY = [
  { code: 'en', label: 'English', short: 'EN', translation: en },
  { code: 'zh-CN', label: '中文', short: '中文', translation: zhCN },
] as const;
export type LanguageCode = typeof LANGUAGE_REGISTRY[number]['code'];
export const SUPPORTED_LANGUAGES = LANGUAGE_REGISTRY.map(({ code }) => code);

const setDocumentLanguage = (language: string): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = LANGUAGE_REGISTRY.find(({ code }) => code === language)?.code || 'en';
};

export const i18nReady = i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: Object.fromEntries(LANGUAGE_REGISTRY.map(({ code, translation }) => [code, { translation }])),
    supportedLngs: SUPPORTED_LANGUAGES,
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
