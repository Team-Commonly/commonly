import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import '../v2.css';
import './v2-landing.css';

// Public, factual comparison page at /compare. Names alternatives using only
// their public positioning and their own published documents. NEVER carries
// private competitive intel.
//
// Three rules, learned the hard way — see docs/commonly-vs-alternatives.md:
//  1. Never claim an alternative LACKS something without a primary source.
//     Earlier drafts asserted Raft had no a2a and Buzz had no memory. Both
//     false, both inferred from a single document.
//  2. Same rule for incumbents: "Slack bots are second-class" is no longer
//     true (Slack AI apps, Teams Entra Agent ID, Lark bots-as-group-members).
//  3. Open source alone is NOT the wedge — Buzz is Apache-2.0, self-hostable
//     and backed by Block. The previous version of this page led with "the
//     difference is ownership"; that is why it was replaced.
//
// Deliberately NOT a checkmark grid. A table we win every row of invites both
// the cherry-picked-rows objection and a size comparison we don't need to
// have. Prose cards are more credible and stack cleanly on mobile.

const REPO = 'https://github.com/Team-Commonly/commonly';
const GITHUB_BRAND = 'GitHub';

const Mark: React.FC<{ size?: number }> = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path d="M 50 17.7 A 22 22 0 1 0 50 46.3" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
    <circle cx="25" cy="32" r="2.4" fill="currentColor" />
    <circle cx="32" cy="32" r="2.4" fill="currentColor" />
    <circle cx="39" cy="32" r="2.4" fill="currentColor" />
  </svg>
);

// Stable keys into the `compare.alts.<key>` / `compare.us.<key>` groups. All
// user-facing copy resolves through t() so both locales stay in lockstep.
const ALTS = ['buzz', 'multica', 'raft', 'workspaces'];
const US = ['native', 'accumulate', 'own', 'pricing'];

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
        <Link className="v2-landing__brand" to="/" style={{ textDecoration: 'none' }}>
          <span className="v2-landing__mark"><Mark size={26} /></span>
          <span className="v2-landing__brand-name">{t('common.brandName')}</span>
        </Link>
        <nav className="v2-landing__nav" aria-label={t('compare.nav.primaryLabel')}>
          <Link className="v2-landing__navlink" to="/">{t('compare.nav.home')}</Link>
          <a className="v2-landing__navlink" href={REPO} target="_blank" rel="noreferrer">{GITHUB_BRAND}</a>
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
          <p className="v2-compare__lede">{t('compare.lede')}</p>

          {/* Concede the parity first. Leading with what's the same is what
              makes the rest of the page believable. */}
          <div className="v2-compare__same">
            <h2 className="v2-compare__h2">{t('compare.sameTitle')}</h2>
            <p className="v2-compare__body">{t('compare.same')}</p>
          </div>

          <h2 className="v2-compare__h2">{t('compare.altsTitle')}</h2>
          <div className="v2-compare__cards">
            {ALTS.map((key) => (
              <article className="v2-compare__card" key={key}>
                <h3 className="v2-compare__card-name">{t(`compare.alts.${key}.name`)}</h3>
                <p className="v2-compare__card-what">{t(`compare.alts.${key}.what`)}</p>
                <p className="v2-compare__card-accept">{t(`compare.alts.${key}.accept`)}</p>
              </article>
            ))}
          </div>

          <h2 className="v2-compare__h2">{t('compare.usTitle')}</h2>
          <div className="v2-compare__cards">
            {US.map((key) => (
              <article className="v2-compare__card v2-compare__card--us" key={key}>
                <h3 className="v2-compare__card-name">
                  <span className="v2-landing__mark"><Mark size={16} /></span>
                  {t(`compare.us.${key}.title`)}
                </h3>
                <p className="v2-compare__card-what">{t(`compare.us.${key}.body`)}</p>
              </article>
            ))}
          </div>

          <div className="v2-compare__close-block">
            <h2 className="v2-compare__h2">{t('compare.closeTitle')}</h2>
            <p className="v2-compare__body">{t('compare.close')}</p>
            <p className="v2-compare__close">{t('compare.closeUs')}</p>
          </div>

          <div className="v2-landing__cta-row v2-compare__cta">
            <Link className="v2-landing__btn v2-landing__btn--primary" to={appHref}>{primaryLabel}</Link>
            <a className="v2-landing__btn v2-landing__btn--ghost" href={REPO} target="_blank" rel="noreferrer">
              <span className="v2-landing__btn-mark"><Mark size={18} /></span>
              {t('compare.actions.starOnGithub')}
            </a>
          </div>
          <p className="v2-compare__note">{t('compare.note')}</p>
        </section>
      </main>

      <footer className="v2-landing__footer">
        <div className="v2-landing__footer-brand">
          <span className="v2-landing__mark"><Mark size={22} /></span>
          <span className="v2-landing__brand-name">{t('common.brandName')}</span>
        </div>
        <div className="v2-landing__footer-cols">
          <div className="v2-landing__footer-col">
            <div className="v2-landing__footer-title">{t('compare.footer.product')}</div>
            <Link className="v2-landing__footer-link" to="/">{t('compare.nav.home')}</Link>
            <Link className="v2-landing__footer-link" to={appHref}>{primaryLabel}</Link>
          </div>
          <div className="v2-landing__footer-col">
            <div className="v2-landing__footer-title">{t('compare.footer.openSource')}</div>
            <a className="v2-landing__footer-link" href={REPO} target="_blank" rel="noreferrer">{GITHUB_BRAND}</a>
            <a className="v2-landing__footer-link" href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">{t('compare.footer.license')}</a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default V2ComparePage;
