// The manage surface for a connected tile: a side drawer on a wide screen, a
// full-height sheet at phone width. It holds the existing panels unchanged; the
// page decides which one.
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ConnectorLogo from './ConnectorLogo';

interface Props {
  type: string;
  title: string;
  onClose: () => void;
  /** Page errors and notices: on a phone the sheet covers the page body, so they show here. */
  notices?: React.ReactNode;
  children: React.ReactNode;
}

const ConnectorDrawer: React.FC<Props> = ({ type, title, onClose, notices, children }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { ref.current?.focus(); }, [type]);

  return (
    <section ref={ref} tabIndex={-1} className="v2-cx-drawer" aria-label={title}>
      <header className="v2-cx-drawer__head">
        <span className="v2-cx-drawer__logo"><ConnectorLogo type={type} size={28} /></span>
        <h2>{title}</h2>
        <button type="button" className="v2-cx-drawer__close" aria-label={t('connectors.closeDetails', { defaultValue: 'Close' })} onClick={onClose}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="v2-cx-drawer__body">{notices}{children}</div>
    </section>
  );
};

export default ConnectorDrawer;
