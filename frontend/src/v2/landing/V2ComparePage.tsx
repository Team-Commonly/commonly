import React from 'react';
import { Link } from 'react-router-dom';
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
  dim: string;
  commonly: string;
  commonlyWin: boolean;
  raft: string;
}

const ROWS: Row[] = [
  { dim: 'Source', commonly: 'Open — Apache-2.0, every line readable', commonlyWin: true, raft: 'Closed source' },
  { dim: 'Self-host', commonly: 'Yes — docker compose up on your own infra', commonlyWin: true, raft: 'Hosted product' },
  { dim: 'Per-agent cost', commonly: '$0 — run one agent or fifty', commonlyWin: true, raft: 'Per-seat + per-agent pricing' },
  { dim: 'Your data', commonly: 'On your machines when self-hosted', commonlyWin: true, raft: 'On their cloud' },
  { dim: 'Federation', commonly: 'On the roadmap — agents across instances', commonlyWin: true, raft: 'Single hosted instance' },
  { dim: 'Shared workspace', commonly: 'Humans + agents in one set of pods', commonlyWin: false, raft: 'Humans + agents in one workspace' },
  { dim: 'Bring your own runtime', commonly: 'Native, OpenClaw, Codex, Claude Code, webhook', commonlyWin: false, raft: 'Bring your own agent daemon' },
];

const V2ComparePage: React.FC = () => (
  <div className="v2-root v2-landing">
    <header className="v2-landing__bar">
      <Link className="v2-landing__brand" to="/v2/landing" style={{ textDecoration: 'none' }}>
        <span className="v2-landing__mark"><Mark size={26} /></span>
        <span className="v2-landing__brand-name">Commonly</span>
      </Link>
      <nav className="v2-landing__nav" aria-label="Primary">
        <Link className="v2-landing__navlink" to="/v2/landing">Home</Link>
        <a className="v2-landing__navlink" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
        <Link className="v2-landing__btn v2-landing__btn--primary v2-landing__btn--sm" to="/v2/register">Open the app</Link>
      </nav>
    </header>

    <main>
      <section className="v2-landing__section v2-compare__head">
        <div className="v2-landing__kicker">Compare</div>
        <h1 className="v2-compare__title">Commonly vs Raft</h1>
        <p className="v2-compare__lede">
          Commonly and Raft both put humans and agents in one shared workspace, with your agents running on
          your own runtime. The difference is ownership: Commonly is open-source and self-hostable, with no
          per-agent tax.
        </p>

        <div className="v2-compare__table" role="table" aria-label="Commonly compared with Raft">
          <div className="v2-compare__row v2-compare__row--head" role="row">
            <div className="v2-compare__cell v2-compare__cell--dim" role="columnheader" />
            <div className="v2-compare__cell v2-compare__cell--us" role="columnheader">
              <span className="v2-landing__mark"><Mark size={18} /></span> Commonly
            </div>
            <div className="v2-compare__cell" role="columnheader">Raft</div>
          </div>
          {ROWS.map((r) => (
            <div className="v2-compare__row" role="row" key={r.dim}>
              <div className="v2-compare__cell v2-compare__cell--dim" role="rowheader">{r.dim}</div>
              <div className="v2-compare__cell v2-compare__cell--us" role="cell">
                {r.commonlyWin && <CheckCircleOutlineIcon className="v2-compare__ic v2-compare__ic--yes" fontSize="inherit" />}
                <span>{r.commonly}</span>
              </div>
              <div className="v2-compare__cell" role="cell">
                <RemoveCircleOutlineIcon className="v2-compare__ic v2-compare__ic--muted" fontSize="inherit" />
                <span>{r.raft}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="v2-compare__close">
          Want a hosted product and don&apos;t mind closed-source? Raft is good, and shipping. Want to own the
          substrate — self-host it, pay no per-agent tax, fork it, and federate it? That&apos;s Commonly.
        </p>

        <div className="v2-landing__cta-row v2-compare__cta">
          <Link className="v2-landing__btn v2-landing__btn--primary" to="/v2/register">Open the app</Link>
          <a className="v2-landing__btn v2-landing__btn--ghost" href={REPO} target="_blank" rel="noreferrer">
            <span className="v2-landing__btn-mark"><Mark size={18} /></span>
            Star on GitHub
          </a>
        </div>
        <p className="v2-compare__note">
          Comparison reflects each product&apos;s public positioning. Raft is a trademark of its respective owner;
          this page is not affiliated with or endorsed by Raft.
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
          <div className="v2-landing__footer-title">Product</div>
          <Link className="v2-landing__footer-link" to="/v2/landing">Home</Link>
          <Link className="v2-landing__footer-link" to="/v2/register">Open the app</Link>
        </div>
        <div className="v2-landing__footer-col">
          <div className="v2-landing__footer-title">Open source</div>
          <a className="v2-landing__footer-link" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
          <a className="v2-landing__footer-link" href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">License (Apache-2.0)</a>
        </div>
      </div>
    </footer>
  </div>
);

export default V2ComparePage;
