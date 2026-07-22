import React from 'react';
import { useTranslation } from 'react-i18next';

// Language names are self-labels, not localized chrome.
const ENGLISH_LANGUAGE_NAME = 'EN';
const CHINESE_LANGUAGE_NAME = '中文';

const V2LangSwitch: React.FC = () => {
  const { t, i18n } = useTranslation();
  const activeLanguage = i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';

  const selectLanguage = (language: 'en' | 'zh-CN') => {
    void i18n.changeLanguage(language);
  };

  return (
    <div className="v2-lang-switch" role="group" aria-label={t('common.language.label')}>
      <button
        type="button"
        className={`v2-lang-switch__option${activeLanguage === 'en' ? ' v2-lang-switch__option--active' : ''}`}
        aria-pressed={activeLanguage === 'en'}
        aria-label={t('common.language.switchToEnglish')}
        onClick={() => selectLanguage('en')}
      >
        {ENGLISH_LANGUAGE_NAME}
      </button>
      <button
        type="button"
        className={`v2-lang-switch__option${activeLanguage === 'zh-CN' ? ' v2-lang-switch__option--active' : ''}`}
        aria-pressed={activeLanguage === 'zh-CN'}
        aria-label={t('common.language.switchToChinese')}
        onClick={() => selectLanguage('zh-CN')}
      >
        {CHINESE_LANGUAGE_NAME}
      </button>
    </div>
  );
};

export default V2LangSwitch;
