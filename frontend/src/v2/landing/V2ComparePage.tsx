import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import '../v2.css';
import './v2-landing.css';

// Public, factual comparison page at /compare. Names Raft using only its public
// facts (closed source, hosted product, per-seat + per-agent pricing). NEVER
// carries private competitive intel — the framing is "the difference is
// ownership", generous to Raft, grounded in what anyone can verify.

const REPO = 'https://github.com/Team-Commonly/commonly';

const Mark: React.FC<{ size?: number }> = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path d="M 50 17.7 A 22 22 0 1 0 50 46.3" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
    <circle cx="25" cy="32" r="2.4" fill="currentColor" />
    <circle cx="32" cy="32" r="2.4" fill="currentColor" />
    <circle cx="39" cy="32" r="2.4" fill="currentColor" />
  </svg>
);

interface Row {
  // Stable key into the `compare.rows.<key>` translation group. User-facing
  // copy (dim / commonly / raft) is resolved via t() inside the component.
  key: string;
  commonlyWin: boolean;
  // Parity dimensions — both products offer it. Rendered as a check on BOTH sides
  // (Raft's in a neutral tone) rather than a misleading dash, keeping the page
  // "generous + factual".
  parity?: boolean;
}

const ROWS: Row[] = [
  { key: 'source', commonlyWin: true },
  { key: 'selfHost', commonlyWin: true },
  { key: 'perAgentCost', commonlyWin: true },
  { key: 'yourData', commonlyWin: true },
  { key: 'federation', commonlyWin: true },
  { key: 'sharedWorkspace', commonlyWin: false, parity: true },
  { key: 'byoRuntime', commonlyWin: false, parity: true },
];

const V2ComparePage: React.FC = () => {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  // Signed-out visitors get routed to /v2/register (invite-code + waitlist),
  // not the /v2/login dead-end. Returning users use the "Sign in" nav link.
  const appHref = isAuthenticated ? '/v2' : '/v2/register';
  const primaryLabel = isAuthenticated ? t('compare.actions.openApp') : t('compare.actions.getStarted');
  return (
  <div className="v2-root v2-landing">
    <header className="v2-landing__bar">
      <Link className="v2-landing__brand" to="/v2/landing" style={{ textDecoration: 'none' }}>
        <span className="v2-landing__mark"><Mark size={26} /></span>
        <span className="v2-landing__brand-name">Commonly</span>
      </Link>
      <nav className="v2-landing__nav" aria-label={t('compare.nav.primaryLabel')}>
        <Link className="v2-landing__navlink" to="/v2/landing">{t('compare.nav.home')}</Link>
        <a className="v2-landing__navlink" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
        {!isAuthenticated && (
          <Link className="v2-landing__navlink" to="/v2/login">{t('compare.nav.signIn')}</Link>
        )}
        <Link className="v2-landing__btn v2-landing__btn--primary v2-landing__btn--sm" to={appHref}>
          {isAuthenticated ? t('compare.actions.openApp') : t('compare.actions.getStarted')}
        </Link>
      </nav>
    </header>

    <main>
      <section className="v2-landing__section v2-compare__head">
        <div className="v2-landing__kicker">{t('compare.kicker')}</div>
        <h1 className="v2-compare__title">{t('compare.title')}</h1>
        <p className="v2-compare__lede">
          {t('compare.lede')}
        </p>

        <div className="v2-compare__table" role="table" aria-label={t('compare.table.ariaLabel')}>
          <div className="v2-compare__row v2-compare__row--head" role="row">
            <div className="v2-compare__cell v2-compare__cell--dim" role="columnheader" />
            <div className="v2-compare__cell v2-compare__cell--us" role="columnheader">
              <span className="v2-landing__mark"><Mark size={18} /></span> {t('compare.table.commonly')}
            </div>
            <div className="v2-compare__cell" role="columnheader">{t('compare.table.raft')}</div>
          </div>
          {ROWS.map((r) => (
            <div className="v2-compare__row" role="row" key={r.key}>
              <div className="v2-compare__cell v2-compare__cell--dim" role="rowheader">{t(`compare.rows.${r.key}.dim`)}</div>
              <div className="v2-compare__cell v2-compare__cell--us" role="cell">
                {(r.commonlyWin || r.parity) && <CheckCircleOutlineIcon className="v2-compare__ic v2-compare__ic--yes" fontSize="inherit" />}
                <span>{t(`compare.rows.${r.key}.commonly`)}</span>
              </div>
              <div className="v2-compare__cell" role="cell">
                {r.parity
                  ? <CheckCircleOutlineIcon className="v2-compare__ic v2-compare__ic--muted" fontSize="inherit" />
                  : <RemoveCircleOutlineIcon className="v2-compare__ic v2-compare__ic--muted" fontSize="inherit" />}
                <span>{t(`compare.rows.${r.key}.raft`)}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="v2-compare__close">
          {t('compare.close')}
        </p>

        <div className="v2-landing__cta-row v2-compare__cta">
          <Link className="v2-landing__btn v2-landing__btn--primary" to={appHref}>{primaryLabel}</Link>
          <a className="v2-landing__btn v2-landing__btn--ghost" href={REPO} target="_blank" rel="noreferrer">
            <span className="v2-landing__btn-mark"><Mark size={18} /></span>
            {t('compare.actions.starOnGithub')}
          </a>
        </div>
        <p className="v2-compare__note">
          {t('compare.note')}
        </p>
      </section>
    </main>

    <footer className="v2-landing__footer">
      <div className="v2-landing__footer-brand">
        <span className="v2-landing__mark"><Mark size={22} /></span>
        <span className="v2-landing__brand-name">Commonly</span>
      </div>
      <div className="v2-landing__footer-cols">
        <div className="v2-landing__footer-col">
          <div className="v2-landing__footer-title">{t('compare.footer.product')}</div>
          <Link className="v2-landing__footer-link" to="/v2/landing">{t('compare.nav.home')}</Link>
          <Link className="v2-landing__footer-link" to={appHref}>{primaryLabel}</Link>
        </div>
        <div className="v2-landing__footer-col">
          <div className="v2-landing__footer-title">{t('compare.footer.openSource')}</div>
          <a className="v2-landing__footer-link" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
          <a className="v2-landing__footer-link" href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">{t('compare.footer.license')}</a>
        </div>
      </div>
    </footer>
  </div>
  );
};

export default V2ComparePage;
