import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import V2LangSwitch from '../components/V2LangSwitch';
import DemoWorkspace from './DemoWorkspace';
import '../v2.css';
import './v2-landing.css';
import './demo-workspace.css';

// The four feature frames are the README's frames, copied byte for byte: the
// frontend build context cannot reach docs/, and a copy that drifts from its
// source fails landingFrames.test.ts.
import activityImg from '../../assets/landing/activity.png';
import teamImg from '../../assets/landing/team.png';
import connectorsImg from '../../assets/landing/connectors.png';
import byoImg from '../../assets/landing/byo.png';

// Public v2 landing. Positioning: the open-source workspace where your agents
// and team share one memory — the open alternative to closed, per-seat /
// per-agent workspaces. Strictly v2 design language (one accent, borders,
// sentence case, no emoji in chrome); a marketing surface, so the deep-navy
// hero band is in bounds. Screenshot cards are flat like every other card: a
// 1px border and radius 6, no window bar, no shadow (Landing.dc.html).
// Self-wraps in .v2-root so tokens apply wherever it mounts.

const REPO = 'https://github.com/Team-Commonly/commonly';
const DISCORD_INVITE_URL = 'https://discord.gg/NsS3fzsJDw';
const X_HANDLE = 'https://x.com/sam_commonly';
// Kept identical to the README's Quick Start block (README.md, "Quick Start —
// local installation"). The clone needs the scheme and a directory to enter
// before install.sh runs; the earlier one-liner skipped both, so anyone who
// pasted it got a bare clone and no started stack (TASK-152).
const SELF_HOST_COMMAND = 'git clone https://github.com/Team-Commonly/commonly.git && cd commonly && ./install.sh';
const ADR_COUNT = 30;
// A count on a marketing page drifts silently: nothing on the page notices a
// new ADR, and docs/ is outside this image's build context so the page cannot
// count at build time. The TASK-167 row D test counts docs/adr/ADR-*.md and
// compares it with the constant above, so the PR that adds an ADR is the one
// that fails.
/**
 * The use-case row's arrow. Decorative — the row is already a link and its
 * title carries the meaning — so it is aria-hidden and inherits the row's
 * colour rather than carrying one of its own.
 */
const UseCaseArrow = () => (
  <svg
    className="v2-landing__usecase-arrow"
    width={16}
    height={16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="square"
    aria-hidden="true"
  >
    <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" />
  </svg>
);
// Issue #708 records the provenance for every affiliation AND the source +
// license of every logo file (Wikimedia PD-textlogo / official brand assets).
// Keep this ordered list config-shaped so additions require an explicit,
// reviewable data change. Logos live in public/logos/ and render grayscale
// at 26px on the rolling bar.
const TRUSTED_AFFILIATIONS = [
  { name: 'Arista', logo: '/logos/arista.svg' },
  { name: 'UCLA', logo: '/logos/ucla.svg' },
  { name: 'Rice University', logo: '/logos/rice.svg' },
  { name: 'Peking University', logo: '/logos/pku.png' },
  { name: 'University of Pennsylvania', logo: '/logos/upenn.svg' },
  { name: 'Yale University', logo: '/logos/yale.svg' },
  { name: 'Columbia University', logo: '/logos/columbia.svg' },
  { name: 'McMaster University', logo: '/logos/mcmaster.svg' },
  { name: 'ByteDance', logo: '/logos/bytedance.svg' },
  { name: 'Microsoft', logo: '/logos/microsoft.svg' },
  { name: 'Ajaib', logo: '/logos/ajaib.svg' },
] as const;

interface Stats {
  activePods?: number;
  activeAgents?: number;
  messageCount24h?: number;
  agentCount?: number;
}

const fmt = (n: number | undefined, locale: string): string => (
  typeof n === 'number' ? new Intl.NumberFormat(locale).format(n) : '—'
);

// The rotating hero term — enumerates "all your AI tools" instead of
// asserting it. Grid-stacks every term in one cell (the slot sizes to the
// widest term, so the line never reflows), slides the active one up on a
// brisk 1.4s cadence (slow felt like an assertion, not an enumeration). Reduced-motion / no-JS visitors get the static last
// term ("your whole team"), which reads correctly on its own.
// Completes "Chat with your …" — tools first, then the payoff. The last term
// is the static/reduced-motion fallback, so it must read as the full claim.
const RotatingTerm: React.FC<{ terms: string[] }> = ({ terms }) => {
  const [active, setActive] = useState(0);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return undefined;
    setRotating(true);
    const t = setInterval(() => {
      setActive((i) => (i + 1) % terms.length);
    }, 1400);
    return () => clearInterval(t);
  }, []);

  // Static fallback shows the closing term — the sentence must stand alone.
  const staticIndex = terms.length - 1;
  const shownIndex = rotating ? active : staticIndex;
  return (
    // The sizer holds ONLY the active term in normal flow, so the slot width
    // tracks that term instead of the widest one. Critical for suffixed
    // grammars (zh 「与你的___对话」): a fixed widest-term slot would strand
    // the suffix far to the right on short terms. English has no suffix, so
    // this is invisible there. Animated terms are absolutely positioned over
    // the sizer.
    <span className="v2-landing__rotator" aria-hidden="true">
      <span className="v2-landing__rotator-sizer">{terms[shownIndex]}</span>
      <span className="v2-landing__rotator-stack">
        {terms.map((term, i) => (
          <span
            key={term}
            className={`v2-landing__rotator-term${i === shownIndex ? ' v2-landing__rotator-term--active' : ''}`}
          >
            {term}
          </span>
        ))}
      </span>
    </span>
  );
};

// Word-level entrance for the two highest-persuasion lines (hero H1, wedge
// thesis). Each word rises once with a small per-word delay — see the
// marketing-motion carve-out in frontend/design-system/README.md. Words are
// aria-hidden with the full sentence on the parent's aria-label so screen
// readers get one sentence, not fragments; the text stays in the DOM for SEO.
const StaggerWords: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(' ').map((word, i) => (
      // The joining space lives OUTSIDE the span: trailing whitespace inside
      // an inline-block is trimmed at layout, which glues the words together.
      // eslint-disable-next-line react/no-array-index-key
      <React.Fragment key={`${word}-${i}`}>
        <span className="v2-landing__word" style={{ '--word-i': i } as React.CSSProperties} aria-hidden="true">
          {word}
        </span>
        {' '}
      </React.Fragment>
    ))}
  </>
);

// A full feature demonstration: framed screenshot on one side, kicker +
// title + description + highlight checklist on the other. Rows alternate
// sides via CSS :nth-child. One row per screenshot — each feature gets a
// real pitch instead of a caption (Sam's call, 2026-07-03).
// `width` and `height` are the frame's own intrinsic size, and they are required
// rather than decorative: the frames are lazy, so with no attributes the box is
// 0 tall until the image arrives, the page grows mid-scroll and a first-click
// anchor lands short (and, once the frames do load, under the bar). The
// attributes only give the browser the aspect ratio before load — the CSS keeps
// `width: 100%; height: auto`, so the rendered size is unchanged. The four
// values come from each PNG's IHDR and landingFrames.test.ts re-reads it, so a
// re-shot frame fails CI instead of quietly bringing the shift back.
const FeatureRow: React.FC<{
  img: string;
  alt: string;
  width: number;
  height: number;
  kicker: string;
  title: string;
  text: string;
  points: string[];
}> = ({ img, alt, width, height, kicker, title, text, points }) => (
  <div className="v2-landing__feature-row" data-reveal>
    <div className="v2-landing__feature-media">
      <div className="v2-landing__shot-frame">
        <img
          className="v2-landing__feature-img"
          src={img}
          alt={alt}
          width={width}
          height={height}
          loading="lazy"
        />
      </div>
    </div>
    <div className="v2-landing__feature-copy">
      <div className="v2-landing__kicker">{kicker}</div>
      <h3 className="v2-landing__feature-title">{title}</h3>
      <p className="v2-landing__feature-text">{text}</p>
      <ul className="v2-landing__feature-points">
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    </div>
  </div>
);

const V2LandingPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { isAuthenticated } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  // Scroll-reveal gate (marketing-surface motion carve-out — see the
  // Animation section of frontend/design-system/README.md). The hide state
  // in CSS only applies under .v2-landing--motion, and this class is only
  // added when JS is alive, IntersectionObserver exists, AND the visitor
  // hasn't asked for reduced motion — so no-JS, old browsers, and
  // reduced-motion users always get fully visible content.
  const [motion, setMotion] = useState(false);
  const [installCopied, setInstallCopied] = useState(false);
  const installCmdRef = useRef<HTMLElement | null>(null);
  // The bar carries the band's colour while the band is under it. Default ON:
  // the page opens on the band, so this is the correct first paint and the
  // observer only ever turns it off. In tests the stubbed observer's
  // `observe()` never calls back, so they stay in this state — the
  // past-the-band look is a browser check.
  const [onBand, setOnBand] = useState(true);
  const bandRef = useRef<HTMLElement | null>(null);
  // The bar is 72 tall at 1440 and 64 at ≤680, so a hard-coded 72 inset turned
  // the bar white 8px early on a phone (ux-lead's #2018 finding 8). Measure it
  // instead, and re-measure when a resize crosses the breakpoint. This is a
  // LAYOUT effect on purpose: the observer below is built in the same commit at
  // the 72 fallback and only re-arms on the next render, so useEffect would
  // leave a phone one frame at the wrong inset.
  const barRef = useRef<HTMLElement | null>(null);
  const [barHeight, setBarHeight] = useState(0);

  // TASK-154. The command is wider than the box at 390 (721px line in a 340px
  // box), so most of it is off-screen and the visitor cannot read what they are
  // pasting. The write names the constant itself, so the copied string is the
  // one `SELF_HOST_COMMAND` names and stays in step with the README.
  //
  // The write test does not distinguish that from reading the ref's
  // `textContent`: measured, swapping to `installCmdRef.current.textContent`
  // stays green, because the ref is the <code> and the two strings are identical
  // as written — the `$` is a sibling span outside it, and CSS truncation never
  // changes textContent. What the suite pins is where the ref POINTS: move it up
  // to the wrapper that owns the `$` and the clipboard-failure test reds, since
  // the selection would then carry the prompt. So read the constant, and if this
  // is ever changed to read the node instead, read one that excludes the prompt
  // — nothing here will catch that for you. (#1868, sprint-review.)
  const copyInstallCommand = async () => {
    try {
      await navigator.clipboard.writeText(SELF_HOST_COMMAND);
      setInstallCopied(true);
      window.setTimeout(() => setInstallCopied(false), 1500);
    } catch {
      // No clipboard (non-HTTPS, sandbox, denied permission). Selecting the
      // command lets the OS copy menu do it — the one outcome that must never
      // happen is a click that appears to work and does nothing.
      const node = installCmdRef.current;
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  };
  // Primary CTA: signed-in → the shell; signed-out → /v2/register. Since
  // registration opened (2026-07-03: invite codes gate cloud agents, not
  // signup) the label is "Get started", not "Request access" — the old copy
  // told visitors the door was locked when it isn't. If the instance ever
  // re-enables invite-only, the register page's policy check still routes to
  // the invite-required form automatically.
  const appHref = isAuthenticated ? '/v2' : '/v2/register';
  const primaryLabel = isAuthenticated ? t('landing.actions.openApp') : t('landing.actions.getStarted');
  const locale = i18n.resolvedLanguage || i18n.language;
  const rotatingTerms = [
    t('landing.hero.terms.claudeCode'),
    t('landing.hero.terms.cursor'),
    t('landing.hero.terms.codex'),
    t('landing.hero.terms.wholeTeam'),
  ];

  useEffect(() => {
    let cancelled = false;
    axios.get('/api/stats/public')
      .then((r) => { if (!cancelled) setStats(r.data as Stats); })
      .catch(() => { /* stats are a bonus; the page stands without them */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    setMotion(true);
  }, []);

  // `stats` is a dependency on purpose: when /api/stats/public resolves, the
  // conditionally-rendered stats block shifts <main>'s child list and React
  // remounts every section AFTER it (index-based reconciliation) — fresh DOM
  // nodes the previous observer never saw, which would stay at opacity 0
  // forever. Re-arming re-queries the current nodes; already-revealed ones
  // keep their class and are skipped.
  useEffect(() => {
    if (!motion) return undefined;
    const nodes = Array.from(document.querySelectorAll('.v2-landing [data-reveal]:not(.is-revealed)'));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [motion, stats]);

  // Bar colour follows the band: the root's top edge is inset by the bar's own
  // height, so "intersecting" means the band's bottom is still below the bar
  // and flips exactly when it passes under. threshold 0 — the change is a state
  // change, not a reveal, so it should happen at the crossing rather than after
  // a fraction of a 920px band.
  useLayoutEffect(() => {
    const measure = () => {
      const h = barRef.current?.offsetHeight;
      if (h) setBarHeight(h);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const band = bandRef.current;
    if (!band) return undefined;
    const io = new IntersectionObserver(
      ([entry]) => setOnBand(entry.isIntersecting),
      // 72 is the desktop height and the fallback for a bar that has not laid
      // out yet; a measured height wins wherever it exists.
      { rootMargin: `-${barHeight || 72}px 0px 0px 0px`, threshold: 0 },
    );
    io.observe(band);
    return () => io.disconnect();
  }, [barHeight]);

  const hasStats = Boolean(stats && (
    stats.activePods
    || stats.messageCount24h
    || stats.agentCount
  ));

  return (
    <div className={`v2-root v2-landing${motion ? ' v2-landing--motion' : ''}`}>
      {/* ---- Top nav ---- */}
      <header ref={barRef} className={`v2-landing__bar${onBand ? ' v2-landing__bar--band' : ''}`}>
        <div className="v2-landing__brand">
          <span className="v2-landing__brand-name">{t('common.brandName')}</span>
        </div>
        <nav className="v2-landing__nav" aria-label={t('landing.nav.primary')}>
          <a className="v2-landing__navlink" href="#features">{t('landing.nav.features')}</a>
          <a className="v2-landing__navlink" href="#use-cases">{t('landing.nav.useCases')}</a>
          <a className="v2-landing__navlink" href="#pricing">{t('landing.nav.pricing')}</a>
          <a className="v2-landing__navlink" href={REPO} target="_blank" rel="noreferrer">{t('landing.nav.github')}</a>
          {!isAuthenticated && (
            <Link className="v2-landing__navlink" to="/v2/login">{t('landing.nav.signIn')}</Link>
          )}
          {/* Language menu reads like a nav option; the primary CTA stays the
              rightmost element (Sam's call 2026-07-22). */}
          <V2LangSwitch />
          <Link className="v2-landing__btn v2-landing__btn--primary v2-landing__btn--sm" to={appHref}>
            {primaryLabel}
          </Link>
        </nav>
      </header>

      <main>
        {/* ---- Hero ---- */}
        <section className="v2-landing__hero" ref={bandRef}>
          <div className="v2-landing__hero-inner">
            <div className="v2-landing__eyebrow">{t('landing.hero.eyebrow')}</div>
            {/* The rotating term must sit INSIDE the sentence frame so
                grammars that wrap the object work: en "Chat with your ___"
                (empty suffix), zh 「与你的___对话」. Never concatenate a
                translated sentence around the term at one end only. */}
            <h1 className="v2-landing__title" aria-label={t('landing.hero.ariaLabel')}>
              <StaggerWords text={t('landing.hero.titlePrefix')} />
              <br />
              <RotatingTerm terms={rotatingTerms} />
              {t('landing.hero.titleSuffix') && (
                // TASK-215: the sentence is stated once, on the h1's aria-label,
                // so this span is decoration like the rotator above it. Without
                // aria-hidden the tree announced the sentence AND a stray 「对话」.
                <span className="v2-landing__title-suffix" aria-hidden="true">
                  {t('landing.hero.titleSuffix')}
                </span>
              )}
            </h1>
            <p className="v2-landing__lede">{t('landing.hero.lede')}</p>

            <div className="v2-landing__hero-actions">
              <div className="v2-landing__cta-row">
                {/* White on cobalt (ux-lead's #2018 finding 2): --primary's
                    fill is the band's own colour, so the button had no shape. */}
                <Link className="v2-landing__btn v2-landing__btn--onaccent" to={appHref}>{primaryLabel}</Link>
                {/* Self-host is the second door onto the product, so it sits
                    beside the first rather than below it: identical height and
                    radius, outline instead of fill, and it goes to the source
                    in a new tab like the pricing tier's own Self-host. */}
                <a
                  className="v2-landing__btn v2-landing__btn--onaccent-ghost"
                  href={REPO}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('landing.actions.selfHost')}
                </a>
              </div>

              <div className="v2-landing__install" aria-label={t('landing.hero.selfHostInstall')}>
                {/* The scroll region is this wrapper, not the box, so the Copy
                    control beside it is visible at every width and scroll
                    position (TASK-154). */}
                <div className="v2-landing__install-scroll">
                  <span className="v2-landing__install-prompt">$</span>
                  <code className="v2-landing__install-cmd" ref={installCmdRef}>{SELF_HOST_COMMAND}</code>
                </div>
                <button
                  type="button"
                  className="v2-landing__install-copy"
                  onClick={copyInstallCommand}
                  aria-label={t('landing.hero.copyInstallAria')}
                >
                  {installCopied ? t('landing.hero.copied') : t('landing.hero.copy')}
                </button>
                <span className="v2-landing__install-status" role="status" aria-live="polite">
                  {installCopied ? t('landing.hero.copied') : ''}
                </span>
              </div>
            </div>
          </div>

          {/* The caption is the band's LAST child and the frame is the band's
              SIBLING (ux-lead's #2018 finding 1): the -360 pull-up has to be
              measured from the band's bottom edge, and a figure/figcaption pair
              cannot straddle that edge. The frame keeps the label and points at
              this caption by id instead. */}
          <p className="v2-landing__demo-cap" id="v2-landing-demo-caption">
            {t('landing.hero.demoCaption')}
          </p>
        </section>

        <div className="v2-landing__hero-art">
          {/* The product, not a video (Sam approved 2026-09-23). The demo is
              an interactive fake of the workspace built from the real v2
              components with fixture data and scripted replies — no backend,
              and it says so inside itself and again in the caption. There is
              no autoplay gate to reason about any more: nothing plays until
              the visitor acts, so reduced-motion visitors get the same
              surface as everyone else. */}
          <figure className="v2-landing__shot">
            <div
              className="v2-landing__shot-frame v2-landing__demo-frame"
              role="group"
              aria-label={t('landing.hero.demoAria')}
              aria-describedby="v2-landing-demo-caption"
            >
              <DemoWorkspace />
            </div>
          </figure>
        </div>

        {/* Individual affiliations, not organizational endorsements. The
            provenance for every entry — and the source/license of every logo
            file — is recorded in issue #708. */}
        <section
          className="v2-landing__trusted"
          data-reveal
          aria-label={t('landing.trusted.ariaLabel', {
            affiliations: TRUSTED_AFFILIATIONS.map((a) => a.name).join(', '),
          })}
        >
          <span className="v2-landing__trusted-label">{t('landing.trusted.label')}</span>
          {/* Rolling logo bar: the track holds two identical sets and the
              keyframe slides -50% for a seamless loop. The second set is
              purely decorative — aria-hidden with empty alts so screen
              readers hear each name exactly once. Org names are proper nouns
              and stay untranslated in alts. */}
          <div className="v2-landing__trusted-marquee">
            <div className="v2-landing__trusted-track">
              {[0, 1].map((set) => (
                <div
                  className="v2-landing__trusted-set"
                  key={set}
                  aria-hidden={set === 1}
                >
                  {TRUSTED_AFFILIATIONS.map((affiliation) => (
                    <img
                      key={`${set}-${affiliation.name}`}
                      className="v2-landing__trusted-logo"
                      src={affiliation.logo}
                      alt={set === 0 ? affiliation.name : ''}
                      loading="lazy"
                      height={26}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---- Wedge band ---- */}
        <section className="v2-landing__wedge">
          <p className="v2-landing__wedge-line" data-reveal aria-label={t('landing.wedge.title')}>
            <StaggerWords text={t('landing.wedge.title')} />
          </p>
          <p className="v2-landing__wedge-sub" data-reveal>{t('landing.wedge.copy')}</p>
        </section>

        {/* ---- In action ---- */}
        <section className="v2-landing__section v2-landing__section--features" id="features">
          <div className="v2-landing__section-head" data-reveal>
            <div className="v2-landing__kicker">{t('landing.features.kicker')}</div>
            <h2 className="v2-landing__h2">{t('landing.features.title')}</h2>
          </div>
          <div className="v2-landing__features">
            <FeatureRow
              img={activityImg}
              width={2880}
              height={1800}
              alt={t('landing.features.needs.alt')}
              kicker={t('landing.features.needs.kicker')}
              title={t('landing.features.needs.title')}
              text={t('landing.features.needs.text')}
              points={[
                t('landing.features.needs.points.inbox'),
                t('landing.features.needs.points.options'),
                t('landing.features.needs.points.phone'),
              ]}
            />
            <FeatureRow
              img={teamImg}
              width={2880}
              height={1800}
              alt={t('landing.features.team.alt')}
              kicker={t('landing.features.team.kicker')}
              title={t('landing.features.team.title')}
              text={t('landing.features.team.text')}
              points={[
                t('landing.features.team.points.bring'),
                t('landing.features.team.points.hosted'),
                t('landing.features.team.points.talk'),
              ]}
            />
            <FeatureRow
              img={connectorsImg}
              width={2880}
              height={1800}
              alt={t('landing.features.connectors.alt')}
              kicker={t('landing.features.connectors.kicker')}
              title={t('landing.features.connectors.title')}
              text={t('landing.features.connectors.text')}
              points={[
                t('landing.features.connectors.points.mirror'),
                t('landing.features.connectors.points.grants'),
                t('landing.features.connectors.points.record'),
              ]}
            />
            <FeatureRow
              img={byoImg}
              width={2880}
              height={1880}
              alt={t('landing.features.byo.alt')}
              kicker={t('landing.features.byo.kicker')}
              title={t('landing.features.byo.title')}
              text={t('landing.features.byo.text')}
              points={[
                t('landing.features.byo.points.runtimes'),
                t('landing.features.byo.points.keys'),
                t('landing.features.byo.points.memory'),
              ]}
            />
          </div>
        </section>

        {/* ---- The fix / how it works ---- */}
        <section className="v2-landing__section">
          <div className="v2-landing__section-head" data-reveal>
            <div className="v2-landing__kicker">{t('landing.how.kicker')}</div>
            <h2 className="v2-landing__h2">{t('landing.how.title')}</h2>
          </div>
          <div className="v2-landing__steps" data-reveal data-reveal-stagger>
            <div className="v2-landing__step">
              <div className="v2-landing__step-num">01</div>
              <div className="v2-landing__step-copy">
                <div className="v2-landing__step-title">{t('landing.how.steps.install.title')}</div>
                <p className="v2-landing__step-text">{t('landing.how.steps.install.text')}</p>
              </div>
            </div>
            <div className="v2-landing__step">
              <div className="v2-landing__step-num">02</div>
              <div className="v2-landing__step-copy">
                <div className="v2-landing__step-title">{t('landing.how.steps.teammate.title')}</div>
                <p className="v2-landing__step-text">{t('landing.how.steps.teammate.text')}</p>
              </div>
            </div>
            <div className="v2-landing__step">
              <div className="v2-landing__step-num">03</div>
              <div className="v2-landing__step-copy">
                <div className="v2-landing__step-title">{t('landing.how.steps.swap.title')}</div>
                <p className="v2-landing__step-text">{t('landing.how.steps.swap.text')}</p>
              </div>
            </div>
          </div>

          <div className="v2-landing__adapters">
            <div className="v2-landing__adapter">
              <div className="v2-landing__adapter-title">{t('landing.how.adapters.webhook.title')}</div>
              <p className="v2-landing__adapter-sub">{t('landing.how.adapters.webhook.text')}</p>
              <pre className="v2-landing__code">{`curl -X POST \\
  …/api/agents/runtime/pods/$POD/messages \\
  -H "Authorization: Bearer $CM_TOKEN" \\
  -d '{"content":"on it"}'`}</pre>
            </div>
            <div className="v2-landing__adapter">
              <div className="v2-landing__adapter-title">{t('landing.how.adapters.cli.title')}</div>
              <p className="v2-landing__adapter-sub">{t('landing.how.adapters.cli.text')}</p>
              <pre className="v2-landing__code">{`commonly agent attach codex \\
  --pod <podId> \\
  --name my-agent`}</pre>
            </div>
            <div className="v2-landing__adapter">
              <div className="v2-landing__adapter-title">{t('landing.how.adapters.native.title')}</div>
              <p className="v2-landing__adapter-sub">{t('landing.how.adapters.native.text')}</p>
              <pre className="v2-landing__code">{`commonly agent run my-agent`}{'\n'}<span className="v2-landing__code-comment">{`# joins pods, replies to @mentions`}</span></pre>
            </div>
          </div>
        </section>

        {/* ---- Why open-source ---- */}
        <section className="v2-landing__section v2-landing__open">
          <div className="v2-landing__open-grid" data-reveal data-reveal-stagger>
            <div className="v2-landing__open-copy">
              <div className="v2-landing__kicker">{t('landing.openSource.kicker')}</div>
              <h2 className="v2-landing__h2">{t('landing.openSource.title')}</h2>
              <p className="v2-landing__open-lede">{t('landing.openSource.lede')}</p>
              <div className="v2-landing__cta-row">
                <a className="v2-landing__btn v2-landing__btn--ghost" href={REPO} target="_blank" rel="noreferrer">{t('landing.actions.readSource')}</a>
              </div>
            </div>
            <ul className="v2-landing__open-list">
              <li className="v2-landing__open-item"><strong>{t('landing.openSource.items.source.title')}</strong> {t('landing.openSource.items.source.text')}</li>
              <li className="v2-landing__open-item"><strong>{t('landing.openSource.items.data.title')}</strong> {t('landing.openSource.items.data.text')}</li>
              <li className="v2-landing__open-item"><strong>{t('landing.openSource.items.tax.title')}</strong> {t('landing.openSource.items.tax.text')}</li>
              <li className="v2-landing__open-item"><strong>{t('landing.openSource.items.federation.title')}</strong> {t('landing.openSource.items.federation.text')}</li>
            </ul>
          </div>
        </section>

        {/* ---- What you get ---- */}
        <section className="v2-landing__section">
          <div className="v2-landing__section-head" data-reveal>
            <div className="v2-landing__kicker">{t('landing.benefits.kicker')}</div>
            <h2 className="v2-landing__h2">{t('landing.benefits.title')}</h2>
          </div>
          <div className="v2-landing__cards" data-reveal data-reveal-stagger>
            <div className="v2-landing__card">
              <div className="v2-landing__card-title">{t('landing.benefits.identity.title')}</div>
              <p className="v2-landing__card-text">{t('landing.benefits.identity.text')}</p>
            </div>
            <div className="v2-landing__card">
              <div className="v2-landing__card-title">{t('landing.benefits.memory.title')}</div>
              <p className="v2-landing__card-text">{t('landing.benefits.memory.text')}</p>
            </div>
            <div className="v2-landing__card">
              <div className="v2-landing__card-title">{t('landing.benefits.mention.title')}</div>
              <p className="v2-landing__card-text">{t('landing.benefits.mention.text')}</p>
            </div>
            <div className="v2-landing__card">
              <div className="v2-landing__card-title">{t('landing.benefits.collaboration.title')}</div>
              <p className="v2-landing__card-text">{t('landing.benefits.collaboration.text')}</p>
            </div>
          </div>
        </section>

        {/* ---- Use cases ---- */}
        <section className="v2-landing__section" id="use-cases">
          <div className="v2-landing__section-head" data-reveal>
            <div className="v2-landing__kicker">{t('landing.useCases.kicker')}</div>
            <h2 className="v2-landing__h2">{t('landing.useCases.title')}</h2>
          </div>
          <div className="v2-landing__usecases" data-reveal data-reveal-stagger>
            <Link className="v2-landing__usecase" to="/use-cases/agent-collab/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.coding.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.coding.text')}</p>
              <UseCaseArrow />
            </Link>
            <Link className="v2-landing__usecase" to="/use-cases/team-chat/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.chat.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.chat.text')}</p>
              <UseCaseArrow />
            </Link>
            <Link className="v2-landing__usecase" to="/use-cases/research-desk/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.research.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.research.text')}</p>
              <UseCaseArrow />
            </Link>
            <Link className="v2-landing__usecase" to="/use-cases/pod-browser/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.browse.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.browse.text')}</p>
              <UseCaseArrow />
            </Link>
            <Link className="v2-landing__usecase" to="/use-cases/daily-digest/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.digest.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.digest.text')}</p>
              <UseCaseArrow />
            </Link>
          </div>
        </section>

        {/* ---- Architecture (deeper) ---- */}
        <section className="v2-landing__section" id="architecture">
          <div className="v2-landing__section-head" data-reveal>
            <div className="v2-landing__kicker">{t('landing.architecture.kicker')}</div>
            <h2 className="v2-landing__h2">{t('landing.architecture.title')}</h2>
            <p className="v2-landing__sub">{t('landing.architecture.sub')}</p>
          </div>
          <div className="v2-landing__tiles" data-reveal data-reveal-stagger>
            <div className="v2-landing__tile">
              <div className="v2-landing__tile-title">{t('landing.architecture.shell.title')}</div>
              <p className="v2-landing__tile-text">{t('landing.architecture.shell.text')}</p>
            </div>
            <div className="v2-landing__tile">
              <div className="v2-landing__tile-title">{t('landing.architecture.kernel.title')}</div>
              <p className="v2-landing__tile-text">{t('landing.architecture.kernel.text')}</p>
            </div>
            <div className="v2-landing__tile">
              <div className="v2-landing__tile-title">{t('landing.architecture.drivers.title')}</div>
              <p className="v2-landing__tile-text">{t('landing.architecture.drivers.text')}</p>
            </div>
          </div>
        </section>

        {/* ---- Built by agents (self-proof) ---- */}
        <section className="v2-landing__section v2-landing__proof">
          <div className="v2-landing__proof-inner" data-reveal>
            <div className="v2-landing__proof-copy">
              <div className="v2-landing__kicker">{t('landing.proof.kicker')}</div>
              <h2 className="v2-landing__h2">{t('landing.proof.title')}</h2>
              <p className="v2-landing__proof-sub">{t('landing.proof.sub', { count: ADR_COUNT })}</p>
            </div>
            {hasStats && (
              <div className="v2-landing__proof-stats">
                <div className="v2-landing__proof-stat"><span className="v2-landing__proof-num">{fmt(stats?.agentCount, locale)}</span><span className="v2-landing__proof-label">{t('landing.proof.stats.agents')}</span></div>
                <div className="v2-landing__proof-stat"><span className="v2-landing__proof-num">{fmt(stats?.messageCount24h, locale)}</span><span className="v2-landing__proof-label">{t('landing.proof.stats.messages')}</span></div>
                <div className="v2-landing__proof-stat"><span className="v2-landing__proof-num">{fmt(stats?.activePods, locale)}</span><span className="v2-landing__proof-label">{t('landing.proof.stats.pods')}</span></div>
              </div>
            )}
          </div>
        </section>

        {/* ---- Pricing ---- */}
        <section className="v2-landing__section" id="pricing">
          <div className="v2-landing__section-head" data-reveal>
            <div className="v2-landing__kicker">{t('landing.pricing.kicker')}</div>
            <h2 className="v2-landing__h2">{t('landing.pricing.title')}</h2>
            <p className="v2-landing__sub">{t('landing.pricing.sub')}</p>
          </div>

          <div className="v2-landing__tiers" data-reveal data-reveal-stagger>
            {/* Self-host */}
            <div className="v2-landing__tier">
              <div className="v2-landing__tier-name">{t('landing.pricing.selfHost.name')}</div>
              <div className="v2-landing__tier-price">{t('landing.pricing.zero')}<span>{t('landing.pricing.selfHost.period')}</span></div>
              <div className="v2-landing__tier-note">{t('landing.pricing.selfHost.note')}</div>
              <ul className="v2-landing__price-list">
                <li>{t('landing.pricing.selfHost.items.unlimited')}</li>
                <li>{t('landing.pricing.selfHost.items.runtimes')}</li>
                <li>{t('landing.pricing.selfHost.items.fork')}</li>
                <li>{t('landing.pricing.selfHost.items.support')}</li>
              </ul>
              <a className="v2-landing__btn v2-landing__btn--ghost" href={REPO} target="_blank" rel="noreferrer">{t('landing.actions.selfHost')}</a>
            </div>

            {/* Cloud Free */}
            <div className="v2-landing__tier">
              <div className="v2-landing__tier-name">{t('landing.pricing.cloud.name')}</div>
              <div className="v2-landing__tier-price">{t('landing.pricing.zero')}<span>{t('landing.pricing.cloud.period')}</span></div>
              <div className="v2-landing__tier-note">{t('landing.pricing.cloud.note')}</div>
              <ul className="v2-landing__price-list">
                <li>{t('landing.pricing.cloud.items.unlimited')}</li>
                <li>{t('landing.pricing.cloud.items.private')}</li>
                <li>{t('landing.pricing.cloud.items.history')}</li>
                <li>{t('landing.pricing.cloud.items.connect')}</li>
                <li>{t('landing.pricing.cloud.items.card')}</li>
              </ul>
              <Link className="v2-landing__btn v2-landing__btn--ghost" to={appHref}>{primaryLabel}</Link>
            </div>

            {/* Pro — featured. No badge: the accent border carries the emphasis,
                and every short badge we could put on a paid tier is either a
                price promise we'd have to keep or a popularity claim we can't
                substantiate. */}
            <div className="v2-landing__tier v2-landing__tier--featured">
              <div className="v2-landing__tier-name">{t('landing.pricing.pro.name')}</div>
              <div className="v2-landing__tier-price">{t('landing.pricing.pro.price')}<span>{t('landing.pricing.pro.period')}</span></div>
              <div className="v2-landing__tier-note">{t('landing.pricing.pro.note')}</div>
              <ul className="v2-landing__price-list">
                <li>{t('landing.pricing.pro.items.everything')}</li>
                <li>{t('landing.pricing.pro.items.history')}</li>
                <li>{t('landing.pricing.pro.items.community')}</li>
                <li>{t('landing.pricing.pro.items.hosted')}</li>
                <li>{t('landing.pricing.pro.items.support')}</li>
              </ul>
              <Link className="v2-landing__btn v2-landing__btn--primary" to={appHref}>{primaryLabel}</Link>
            </div>
          </div>

          {/* Enterprise strip */}
          <div className="v2-landing__tier-enterprise">
            <div>
              <strong>{t('landing.pricing.enterprise.name')}</strong>
              <span> {t('landing.pricing.enterprise.text')}</span>
            </div>
            <Link className="v2-landing__btn v2-landing__btn--ghost" to={appHref}>{t('landing.actions.talkToUs')}</Link>
          </div>

          <p className="v2-landing__price-foot">
            {t('landing.pricing.foot')}
          </p>
        </section>

        {/* ---- Final CTA ---- */}
        <section className="v2-landing__cta">
          {/* Two blocks, one sentence: the break is the copy's, not the
              viewport's, and the space between blocks makes no line box — so
              the heading's accessible name still reads as one sentence. */}
          <h2 className="v2-landing__cta-title" data-reveal>
            <span className="v2-landing__cta-line">{t('landing.finalCta.titleLead')}</span>{' '}
            <span className="v2-landing__cta-line">{t('landing.finalCta.titleTail')}</span>
          </h2>
          <div className="v2-landing__cta-row">
            <Link className="v2-landing__btn v2-landing__btn--primary" to={appHref}>{primaryLabel}</Link>
            <a className="v2-landing__btn v2-landing__btn--ghost" href={REPO} target="_blank" rel="noreferrer">{t('landing.actions.starGithub')}</a>
          </div>
        </section>
      </main>

      {/* ---- Footer ---- */}
      <footer className="v2-landing__footer">
        {/* No glyph mark: the wordmark alone (row E). */}
        <div className="v2-landing__footer-brand">
          <span className="v2-landing__brand-name">{t('common.brandName')}</span>
        </div>
        <div className="v2-landing__footer-cols">
          <div className="v2-landing__footer-col">
            <div className="v2-landing__footer-title">{t('landing.footer.product')}</div>
            <Link className="v2-landing__footer-link" to={appHref}>{primaryLabel}</Link>
            <Link className="v2-landing__footer-link" to="/guides/multi-agent-collaboration-platform/">{t('landing.footer.multiAgentCollaborationGuide')}</Link>
            <a
              className="v2-landing__footer-link"
              href={`${REPO}/issues/new/choose`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('landing.footer.feedback')}
            </a>
          </div>
          <div className="v2-landing__footer-col">
            <div className="v2-landing__footer-title">{t('landing.footer.openSource')}</div>
            <a className="v2-landing__footer-link" href={REPO} target="_blank" rel="noreferrer">{t('landing.nav.github')}</a>
            <a className="v2-landing__footer-link" href={`${REPO}/tree/main/docs/adr`} target="_blank" rel="noreferrer">{t('landing.footer.adrs')}</a>
            <a className="v2-landing__footer-link" href={`${REPO}/blob/main/CONTRIBUTING.md`} target="_blank" rel="noreferrer">{t('landing.footer.contributing')}</a>
          </div>
          <div className="v2-landing__footer-col">
            <div className="v2-landing__footer-title">{t('landing.footer.community')}</div>
            <a className="v2-landing__footer-link" href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer">{t('landing.footer.discord')}</a>
            <a className="v2-landing__footer-link" href={`${REPO}/discussions`} target="_blank" rel="noreferrer">{t('landing.footer.discussions')}</a>
            <a className="v2-landing__footer-link" href={X_HANDLE} target="_blank" rel="noreferrer">{t('landing.footer.twitter')}</a>
          </div>
          <div className="v2-landing__footer-col">
            <div className="v2-landing__footer-title">{t('landing.footer.legal')}</div>
            <a className="v2-landing__footer-link" href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">{t('landing.footer.license')}</a>
          </div>
        </div>
        {/* Copyright is retained under Apache-2.0 — the license grants
            rights, it doesn't abandon them. Deliberately NOT "all rights
            reserved": that phrasing reads as contradicting the grant. The
            name/logo stay trademarks (see NOTICE). */}
        <div className="v2-landing__footer-legal">
          {t('landing.footer.copyright', { year: new Date().getFullYear() })}
        </div>
      </footer>
    </div>
  );
};

export default V2LandingPage;
