// The manage surface for a connected tile: a side drawer on a wide screen, a
// full-height sheet at phone width. It holds the existing panels unchanged; the
// page decides which one.
//
// It slides in from the right and back out; ConnectorDrawerPresence keeps the
// last drawer mounted, inert, until that exit ends.
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ConnectorLogo from './ConnectorLogo';
import { useExitPresence } from '../utils/motion';

interface Props {
  type: string;
  title: string;
  onClose: () => void;
  /** Page errors and notices: on a phone the sheet covers the page body, so they show here. */
  notices?: React.ReactNode;
  children: React.ReactNode;
  /** Set by ConnectorDrawerPresence while the drawer animates out. */
  exit?: {
    leaving: boolean;
    ref: (node: HTMLElement | null) => void;
    onAnimationEnd: (event: React.AnimationEvent<HTMLElement>) => void;
  };
}

const ConnectorDrawer: React.FC<Props> = ({ type, title, onClose, notices, children, exit }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement | null>(null);
  const exitRef = exit?.ref;
  const setRef = useCallback((node: HTMLElement | null) => {
    ref.current = node;
    exitRef?.(node);
  }, [exitRef]);
  const leaving = Boolean(exit?.leaving);

  useEffect(() => {
    if (leaving) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, leaving]);

  useEffect(() => { ref.current?.focus(); }, [type]);

  return (
    <section
      ref={setRef}
      tabIndex={-1}
      className={`v2-cx-drawer${leaving ? ' is-leaving' : ''}`}
      aria-label={title}
      aria-hidden={leaving || undefined}
      // React 18 passes `inert` through only as a string attribute.
      {...(leaving ? { inert: '' } : {})}
      onAnimationEnd={exit?.onAnimationEnd}
    >
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

// Holds the page's one drawer slot. While open it renders the live drawer; once
// the page renders none, it keeps the last one mounted and inert until its slide
// out ends (or at once under reduced motion; see useExitPresence).
export const ConnectorDrawerPresence: React.FC<{ children: React.ReactElement<Props> | null }> = ({ children }) => {
  const presence = useExitPresence(children);
  if (!presence.shown) return null;
  return React.cloneElement(presence.shown, {
    exit: { leaving: presence.leaving, ref: presence.ref, onAnimationEnd: presence.onAnimationEnd },
  });
};

export default ConnectorDrawer;
