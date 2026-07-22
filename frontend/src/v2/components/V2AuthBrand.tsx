import React from 'react';
import { useTranslation } from 'react-i18next';

// The one brand row for auth-card pages (login / register / forgot / reset /
// oauth-complete). Same mark as the nav rail and the landing page — the
// open-C with three dots — NOT a letter "c" (the old auth pages drifted to a
// plain letter, which read as a different logo next to every other surface).
// Wordmark stays lowercase to match the rail (app chrome, not marketing).
const V2AuthBrand: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="v2-login__brand">
      <span className="v2-rail__brand-icon" aria-label={t('common.brandName')}>
        <svg width="18" height="18" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M 50 17.7 A 22 22 0 1 0 50 46.3" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
          <circle cx="25" cy="32" r="2.4" fill="currentColor" />
          <circle cx="32" cy="32" r="2.4" fill="currentColor" />
          <circle cx="39" cy="32" r="2.4" fill="currentColor" />
        </svg>
      </span>
      {t('common.brandWordmark')}
    </div>
  );
};

export default V2AuthBrand;
