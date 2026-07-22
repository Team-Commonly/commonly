import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Language names are self-labels, not localized chrome — every reader must
// recognize their own language regardless of the active locale.
const LANGUAGES = [
  { code: 'en' as const, label: 'English', short: 'EN' },
  { code: 'zh-CN' as const, label: '中文', short: '中文' },
];
const CARET_ICON = '▾';
const CHECK_ICON = '✓';

// Dropdown language menu (Sam's call 2026-07-22: reads like the other nav
// options, not a two-button pill). Trigger shows the active language; the
// menu lists all languages with the active one checked. Closes on outside
// click, Escape, and selection.
const V2LangSwitch: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = LANGUAGES.find((l) => l.code === i18n.resolvedLanguage) || LANGUAGES[0];

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectLanguage = (code: 'en' | 'zh-CN') => {
    void i18n.changeLanguage(code);
    setOpen(false);
  };

  return (
    <div className="v2-lang-switch" ref={rootRef}>
      <button
        type="button"
        className="v2-lang-switch__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('common.language.label')}
        onClick={() => setOpen((v) => !v)}
      >
        {active.short}
        <span className="v2-lang-switch__caret" aria-hidden="true">{CARET_ICON}</span>
      </button>
      {open && (
        <ul className="v2-lang-switch__menu" role="listbox" aria-label={t('common.language.label')}>
          {LANGUAGES.map((lang) => (
            <li key={lang.code} role="option" aria-selected={lang.code === active.code}>
              <button
                type="button"
                className={`v2-lang-switch__item${lang.code === active.code ? ' v2-lang-switch__item--active' : ''}`}
                onClick={() => selectLanguage(lang.code)}
              >
                <span>{lang.label}</span>
                {lang.code === active.code && (
                  <span className="v2-lang-switch__check" aria-hidden="true">{CHECK_ICON}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default V2LangSwitch;
