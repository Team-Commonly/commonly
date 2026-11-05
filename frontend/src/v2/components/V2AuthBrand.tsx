import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShellGlyph } from '../icons/glyphs';

export type V2HandoffState = 'working' | 'done' | 'error';

// The d215 s-handoff brand row: the provider's tile, a wire, then the mark.
// Working, a cobalt dot runs the dotted wire; done, the wire is solid with a
// check; error, an ink cross sits on it. The wire is decoration: the page's
// title says the state in words.
export interface V2AuthHandoff {
  state: V2HandoffState;
  provider: React.ReactNode;
}

// The one brand row for auth-card pages (login / register / forgot / reset /
// oauth-complete / the Discord return). Same mark as the nav rail and the
// landing page — the open-C with three dots — NOT a letter "c" (the old auth
// pages drifted to a plain letter, which read as a different logo next to
// every other surface). Wordmark stays lowercase to match the rail (app
// chrome, not marketing).
const V2AuthBrand: React.FC<{ handoff?: V2AuthHandoff }> = ({ handoff }) => {
  const { t } = useTranslation();

  return (
    <div className={handoff ? 'v2-login__brand v2-login__brand--handoff' : 'v2-login__brand'}>
      {handoff ? (
        <>
          <span className="v2-handoff__provider">{handoff.provider}</span>
          <span className={`v2-handoff__wire v2-handoff__wire--${handoff.state}`} aria-hidden="true">
            {handoff.state === 'working' ? (
              <span className="v2-handoff__run" />
            ) : (
              <span className="v2-handoff__knot">
                <ShellGlyph name={handoff.state === 'done' ? 'check' : 'close'} size={11} />
              </span>
            )}
          </span>
        </>
      ) : null}
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
