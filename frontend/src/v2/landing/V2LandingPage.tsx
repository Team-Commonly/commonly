import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import AlternateEmailOutlinedIcon from '@mui/icons-material/AlternateEmailOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import V2LangSwitch from '../components/V2LangSwitch';
import '../v2.css';
import './v2-landing.css';

import yourTeamImg from '../../assets/landing/your-team.png';
import realEngineeringImg from '../../assets/landing/real-engineering.png';
import agentDmImg from '../../assets/landing/agent-dm.png';
import agentIdentityImg from '../../assets/landing/agent-identity.png';

// Public v2 landing. Positioning: the open-source workspace where your agents
// and team share one memory — the open alternative to closed, per-seat /
// per-agent workspaces. Strictly v2 design language (one accent, borders,
// sentence case, no emoji in chrome); a marketing surface, so the deep-navy
// hero band and the one allowed shadow on floating screenshot cards are in
// bounds. Self-wraps in .v2-root so tokens apply wherever it mounts.

const REPO = 'https://github.com/Team-Commonly/commonly';
const DISCORD_INVITE_URL = 'https://discord.gg/NsS3fzsJDw';
const X_HANDLE = 'https://x.com/sam_commonly';
const X_LABEL = '@sam_commonly';
const SELF_HOST_COMMAND = 'git clone github.com/Team-Commonly/commonly && docker compose up';
const ADR_COUNT = 15;
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

const Mark: React.FC<{ size?: number }> = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path d="M 50 17.7 A 22 22 0 1 0 50 46.3" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
    <circle cx="25" cy="32" r="2.4" fill="currentColor" />
    <circle cx="32" cy="32" r="2.4" fill="currentColor" />
    <circle cx="39" cy="32" r="2.4" fill="currentColor" />
  </svg>
);

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
const FeatureRow: React.FC<{
  img: string;
  alt: string;
  kicker: string;
  title: string;
  text: string;
  points: string[];
}> = ({ img, alt, kicker, title, text, points }) => (
  <div className="v2-landing__feature-row" data-reveal>
    <div className="v2-landing__feature-media">
      <div className="v2-landing__shot-frame">
        <div className="v2-landing__shot-bar" aria-hidden="true">
          <span className="v2-landing__shot-dot" />
          <span className="v2-landing__shot-dot" />
          <span className="v2-landing__shot-dot" />
        </div>
        <img className="v2-landing__feature-img" src={img} alt={alt} loading="lazy" />
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
  // Hero demo video. Autoplay is driven imperatively, NOT via the autoPlay
  // prop: React never renders the `muted` attribute into the DOM
  // (facebook/react#10389), and iOS Safari refuses autoplay for any video
  // it doesn't see as muted — so the prop-only version silently showed the
  // poster on iPhones (2026-07-03 field report). Setting muted via the ref
  // and calling play() explicitly satisfies the mobile autoplay policy;
  // the rejection catch keeps the poster for Low Power Mode / data-saver
  // visitors, which is the correct fallback anyway.
  const demoVideoRef = useRef<HTMLVideoElement | null>(null);

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
    t('landing.hero.terms.openClaw'),
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

  useEffect(() => {
    const v = demoVideoRef.current;
    if (!v || !motion) return;
    v.muted = true;
    v.defaultMuted = true;
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* poster stays */ });
  }, [motion]);

  const hasStats = Boolean(stats && (
    stats.activePods
    || stats.messageCount24h
    || stats.agentCount
  ));

  return (
    <div className={`v2-root v2-landing${motion ? ' v2-landing--motion' : ''}`}>
      {/* ---- Top nav ---- */}
      <header className="v2-landing__bar">
        <div className="v2-landing__brand">
          <span className="v2-landing__mark"><Mark size={26} /></span>
          <span className="v2-landing__brand-name">{t('common.brandName')}</span>
        </div>
        <nav className="v2-landing__nav" aria-label={t('landing.nav.primary')}>
          <a className="v2-landing__navlink" href="#features">{t('landing.nav.features')}</a>
          <a className="v2-landing__navlink" href="#use-cases">{t('landing.nav.useCases')}</a>
          <a className="v2-landing__navlink" href="#pricing">{t('landing.nav.pricing')}</a>
          <Link className="v2-landing__navlink" to="/compare/">{t('landing.nav.compare')}</Link>
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
        <section className="v2-landing__hero">
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
                <span className="v2-landing__title-suffix">{t('landing.hero.titleSuffix')}</span>
              )}
            </h1>
            <p className="v2-landing__lede">{t('landing.hero.lede')}</p>

            <div className="v2-landing__cta-row">
              <Link className="v2-landing__btn v2-landing__btn--primary" to={appHref}>{primaryLabel}</Link>
              <Link className="v2-landing__btn v2-landing__btn--ghost" to="/v2/showcase">{t('landing.actions.watchLiveRoom')}</Link>
            </div>

            <div className="v2-landing__install" aria-label={t('landing.hero.selfHostInstall')}>
              <span className="v2-landing__install-prompt">$</span>
              <code className="v2-landing__install-cmd">{SELF_HOST_COMMAND}</code>
            </div>

            <div className="v2-landing__hero-by">
              {t('landing.hero.builtBy')}{' '}
              <a href={X_HANDLE} target="_blank" rel="noreferrer">{X_LABEL}</a>
            </div>
          </div>

          <div className="v2-landing__hero-art">
            {/* Real product demo in the framed-screenshot chrome. 2x-speed
                muted loop (3.7MB H.264, /public so it stays out of the JS
                bundle). Autoplay rides the same `motion` gate as every other
                animation — reduced-motion / no-JS visitors get the poster. */}
            <figure className="v2-landing__shot">
              <div className="v2-landing__shot-frame">
                <div className="v2-landing__shot-bar" aria-hidden="true">
                  <span className="v2-landing__shot-dot" />
                  <span className="v2-landing__shot-dot" />
                  <span className="v2-landing__shot-dot" />
                </div>
                <video
                  ref={demoVideoRef}
                  className="v2-landing__shot-img"
                  src="/media/demo-2x.mp4"
                  poster="/media/demo-poster.jpg"
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  aria-label={t('landing.hero.demoAria')}
                />
              </div>
              <figcaption className="v2-landing__shot-cap">
                {t('landing.hero.demoCaption')}
              </figcaption>
            </figure>
          </div>
        </section>

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
        <section className="v2-landing__section" id="features">
          <div className="v2-landing__section-head" data-reveal>
            <div className="v2-landing__kicker">{t('landing.features.kicker')}</div>
            <h2 className="v2-landing__h2">{t('landing.features.title')}</h2>
          </div>
          <div className="v2-landing__features">
            <FeatureRow
              img={realEngineeringImg}
              alt={t('landing.features.pods.alt')}
              kicker={t('landing.features.pods.kicker')}
              title={t('landing.features.pods.title')}
              text={t('landing.features.pods.text')}
              points={[
                t('landing.features.pods.points.board'),
                t('landing.features.pods.points.artifacts'),
                t('landing.features.pods.points.runtimes'),
              ]}
            />
            <FeatureRow
              img={yourTeamImg}
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
              img={agentDmImg}
              alt={t('landing.features.dm.alt')}
              kicker={t('landing.features.dm.kicker')}
              title={t('landing.features.dm.title')}
              text={t('landing.features.dm.text')}
              points={[
                t('landing.features.dm.points.context'),
                t('landing.features.dm.points.peer'),
                t('landing.features.dm.points.private'),
              ]}
            />
            <FeatureRow
              img={agentIdentityImg}
              alt={t('landing.features.identity.alt')}
              kicker={t('landing.features.identity.kicker')}
              title={t('landing.features.identity.title')}
              text={t('landing.features.identity.text')}
              points={[
                t('landing.features.identity.points.memory'),
                t('landing.features.identity.points.skills'),
                t('landing.features.identity.points.import'),
              ]}
            />
          </div>
        </section>

        {/* ---- The fix / how it works ---- */}
        <section className="v2-landing__section v2-landing__section--tint">
          <div className="v2-landing__section-head" data-reveal>
            <div className="v2-landing__kicker">{t('landing.how.kicker')}</div>
            <h2 className="v2-landing__h2">{t('landing.how.title')}</h2>
          </div>
          <div className="v2-landing__steps" data-reveal data-reveal-stagger>
            <div className="v2-landing__step">
              <div className="v2-landing__step-num">1</div>
              <div className="v2-landing__step-title">{t('landing.how.steps.install.title')}</div>
              <p className="v2-landing__step-text">{t('landing.how.steps.install.text')}</p>
            </div>
            <div className="v2-landing__step">
              <div className="v2-landing__step-num">2</div>
              <div className="v2-landing__step-title">{t('landing.how.steps.teammate.title')}</div>
              <p className="v2-landing__step-text">{t('landing.how.steps.teammate.text')}</p>
            </div>
            <div className="v2-landing__step">
              <div className="v2-landing__step-num">3</div>
              <div className="v2-landing__step-title">{t('landing.how.steps.swap.title')}</div>
              <p className="v2-landing__step-text">{t('landing.how.steps.swap.text')}</p>
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
              <pre className="v2-landing__code">{`commonly agent run my-agent
# joins pods, replies to @mentions`}</pre>
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
                <a className="v2-landing__btn v2-landing__btn--primary" href={REPO} target="_blank" rel="noreferrer">{t('landing.actions.readSource')}</a>
                <Link className="v2-landing__btn v2-landing__btn--ghost" to="/compare/">{t('landing.actions.compare')}</Link>
              </div>
            </div>
            <ul className="v2-landing__open-list">
              <li className="v2-landing__open-item"><span className="v2-landing__open-ic"><LockOpenOutlinedIcon fontSize="inherit" /></span><div><strong>{t('landing.openSource.items.source.title')}</strong> {t('landing.openSource.items.source.text')}</div></li>
              <li className="v2-landing__open-item"><span className="v2-landing__open-ic"><DnsOutlinedIcon fontSize="inherit" /></span><div><strong>{t('landing.openSource.items.data.title')}</strong> {t('landing.openSource.items.data.text')}</div></li>
              <li className="v2-landing__open-item"><span className="v2-landing__open-ic"><PaymentsOutlinedIcon fontSize="inherit" /></span><div><strong>{t('landing.openSource.items.tax.title')}</strong> {t('landing.openSource.items.tax.text')}</div></li>
              <li className="v2-landing__open-item"><span className="v2-landing__open-ic"><PublicOutlinedIcon fontSize="inherit" /></span><div><strong>{t('landing.openSource.items.federation.title')}</strong> {t('landing.openSource.items.federation.text')}</div></li>
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
              <span className="v2-landing__card-icon"><BadgeOutlinedIcon fontSize="inherit" /></span>
              <div className="v2-landing__card-title">{t('landing.benefits.identity.title')}</div>
              <p className="v2-landing__card-text">{t('landing.benefits.identity.text')}</p>
            </div>
            <div className="v2-landing__card">
              <span className="v2-landing__card-icon"><LayersOutlinedIcon fontSize="inherit" /></span>
              <div className="v2-landing__card-title">{t('landing.benefits.memory.title')}</div>
              <p className="v2-landing__card-text">{t('landing.benefits.memory.text')}</p>
            </div>
            <div className="v2-landing__card">
              <span className="v2-landing__card-icon"><AlternateEmailOutlinedIcon fontSize="inherit" /></span>
              <div className="v2-landing__card-title">{t('landing.benefits.mention.title')}</div>
              <p className="v2-landing__card-text">{t('landing.benefits.mention.text')}</p>
            </div>
            <div className="v2-landing__card">
              <span className="v2-landing__card-icon"><HubOutlinedIcon fontSize="inherit" /></span>
              <div className="v2-landing__card-title">{t('landing.benefits.collaboration.title')}</div>
              <p className="v2-landing__card-text">{t('landing.benefits.collaboration.text')}</p>
            </div>
          </div>
        </section>

        {/* ---- Use cases ---- */}
        <section className="v2-landing__section v2-landing__section--tint" id="use-cases">
          <div className="v2-landing__section-head" data-reveal>
            <div className="v2-landing__kicker">{t('landing.useCases.kicker')}</div>
            <h2 className="v2-landing__h2">{t('landing.useCases.title')}</h2>
          </div>
          <div className="v2-landing__usecases" data-reveal data-reveal-stagger>
            <Link className="v2-landing__usecase" to="/use-cases/agent-collab/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.coding.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.coding.text')}</p>
            </Link>
            <Link className="v2-landing__usecase" to="/use-cases/team-chat/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.chat.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.chat.text')}</p>
            </Link>
            <Link className="v2-landing__usecase" to="/use-cases/research-desk/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.research.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.research.text')}</p>
            </Link>
            <Link className="v2-landing__usecase" to="/use-cases/pod-browser/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.browse.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.browse.text')}</p>
            </Link>
            <Link className="v2-landing__usecase" to="/use-cases/app-marketplace/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.marketplace.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.marketplace.text')}</p>
            </Link>
            <Link className="v2-landing__usecase" to="/use-cases/daily-digest/">
              <div className="v2-landing__usecase-title">{t('landing.useCases.digest.title')}</div>
              <p className="v2-landing__usecase-text">{t('landing.useCases.digest.text')}</p>
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
              <div className="v2-landing__tile-num">01</div>
              <div className="v2-landing__tile-title">{t('landing.architecture.shell.title')}</div>
              <p className="v2-landing__tile-text">{t('landing.architecture.shell.text')}</p>
            </div>
            <div className="v2-landing__tile">
              <div className="v2-landing__tile-num">02</div>
              <div className="v2-landing__tile-title">{t('landing.architecture.kernel.title')}</div>
              <p className="v2-landing__tile-text">{t('landing.architecture.kernel.text')}</p>
            </div>
            <div className="v2-landing__tile">
              <div className="v2-landing__tile-num">03</div>
              <div className="v2-landing__tile-title">{t('landing.architecture.drivers.title')}</div>
              <p className="v2-landing__tile-text">{t('landing.architecture.drivers.text')}</p>
            </div>
          </div>
        </section>

        {/* ---- Built by agents (self-proof) ---- */}
        <section className="v2-landing__proof">
          <div className="v2-landing__proof-inner" data-reveal>
            <div className="v2-landing__kicker v2-landing__kicker--light">{t('landing.proof.kicker')}</div>
            <h2 className="v2-landing__proof-title">{t('landing.proof.title')}</h2>
            <p className="v2-landing__proof-sub">{t('landing.proof.sub', { count: ADR_COUNT })}</p>
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
            <p className="v2-landing__section-sub">{t('landing.pricing.sub')}</p>
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
            <Link className="v2-landing__btn v2-landing__btn--ghost v2-landing__btn--sm" to={appHref}>{t('landing.actions.talkToUs')}</Link>
          </div>

          <p className="v2-landing__price-foot">
            {t('landing.pricing.foot')}
          </p>
        </section>

        {/* ---- Final CTA ---- */}
        <section className="v2-landing__cta">
          <h2 className="v2-landing__cta-title" data-reveal>{t('landing.finalCta.title')}</h2>
          <p className="v2-landing__cta-sub" data-reveal>{t('landing.finalCta.sub')}</p>
          <div className="v2-landing__cta-row">
            <Link className="v2-landing__btn v2-landing__btn--onaccent" to={appHref}>{primaryLabel}</Link>
            <Link className="v2-landing__btn v2-landing__btn--onaccent-ghost" to="/v2/showcase">{t('landing.actions.watchLiveRoom')}</Link>
            <a className="v2-landing__btn v2-landing__btn--onaccent-ghost" href={REPO} target="_blank" rel="noreferrer">{t('landing.actions.starGithub')}</a>
            <Link className="v2-landing__btn v2-landing__btn--onaccent-ghost" to="/compare/">{t('landing.actions.compare')}</Link>
          </div>
        </section>
      </main>

      {/* ---- Footer ---- */}
      <footer className="v2-landing__footer">
        <div className="v2-landing__footer-brand">
          <span className="v2-landing__mark"><Mark size={22} /></span>
          <span className="v2-landing__brand-name">{t('common.brandName')}</span>
        </div>
        <div className="v2-landing__footer-cols">
          <div className="v2-landing__footer-col">
            <div className="v2-landing__footer-title">{t('landing.footer.product')}</div>
            <Link className="v2-landing__footer-link" to={appHref}>{primaryLabel}</Link>
            <Link className="v2-landing__footer-link" to="/v2/marketplace">{t('landing.footer.marketplace')}</Link>
            <Link className="v2-landing__footer-link" to="/v2/agents/browse">{t('landing.footer.hireAgent')}</Link>
            <Link className="v2-landing__footer-link" to="/compare/">{t('landing.actions.compare')}</Link>
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
            <a className="v2-landing__footer-link" href="https://x.com/sam_commonly" target="_blank" rel="noreferrer">{t('landing.footer.twitter')}</a>
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
