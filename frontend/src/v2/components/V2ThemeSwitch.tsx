import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getV2Theme, resolveV2Theme, setV2Theme, subscribeV2Theme } from '../utils/theme';
import './v2-theme-switch.css';

const Sun = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" /></svg>
);

// D224 / TASK-740: the sun and moon pair from the d215 rail. It writes the same
// stored preference as Settings > Theme (setV2Theme), so there is one setting.
// An 'auto' preference shows whichever set the OS is giving; a click makes it
// explicit.
const V2ThemeSwitch: React.FC = () => {
  const { t } = useTranslation();
  const active = useSyncExternalStore(
    subscribeV2Theme,
    () => resolveV2Theme(getV2Theme()),
    () => 'light',
  );
  return (
    <div className="seg seg--ic seg--rail" role="group" aria-label={t('common.theme.label')}>
      <button type="button" data-t="light" title={t('common.theme.light')} aria-label={t('common.theme.light')}
        aria-pressed={active === 'light'} onClick={() => setV2Theme('light')}><Sun /></button>
      <button type="button" data-t="dark" title={t('common.theme.dark')} aria-label={t('common.theme.dark')}
        aria-pressed={active === 'dark'} onClick={() => setV2Theme('dark')}><Moon /></button>
    </div>
  );
};

export default V2ThemeSwitch;
