import React from 'react';
import { useNavigate } from 'react-router-dom';
import V2Avatar from '../components/V2Avatar';
import { PERSONA_CARDS, PersonaCard } from './personaCatalogData';
import '../v2.css';
import './v2-persona-catalog.css';

// Phase 1 of the persona plan (ADR-022 D1/D2): the hire surface sells
// COLLEAGUES, not runtimes. Cards are evidence-shaped — what this persona
// does, what it will do first, a real exchange — and the only runtime word
// on any card is ruling 1's named exception ("Runs on your machine").
// The where-step (Phase 2) replaces the availability states below with a
// real choice; until then every CTA is honest about what works today.

const AVAILABILITY: Record<PersonaCard['availability'], { dot: string; label: string; cta: string | null }> = {
  workspace: { dot: 'live', label: 'Answers now', cta: 'Open your workspace' },
  connect: { dot: 'session', label: 'Answers while your session runs', cta: 'Connect' },
  soon: { dot: 'soon', label: 'Hosted seat opens soon', cta: null },
};

const PersonaCardView: React.FC<{ card: PersonaCard }> = ({ card }) => {
  const navigate = useNavigate();
  const availability = AVAILABILITY[card.availability];

  const onCta = () => {
    if (card.availability === 'workspace') navigate('/v2');
    if (card.availability === 'connect') navigate('/v2/agents/byo');
  };

  return (
    <article className="v2-pcat__card">
      <header className="v2-pcat__card-head">
        <span className="v2-pcat__avatar-well">
          <V2Avatar name={card.name} size="md" kind="agent" seed={card.avatarSeed} />
        </span>
        <div className="v2-pcat__card-title">
          <h2 className="v2-pcat__name">{card.name}</h2>
          <div className="v2-pcat__role">{card.role}</div>
        </div>
        <div className={`v2-pcat__liveness v2-pcat__liveness--${availability.dot}`} title={availability.label}>
          <span className="v2-pcat__dot" />
          {availability.label}
        </div>
      </header>

      <p className="v2-pcat__oneliner">{card.oneLiner}</p>

      <div className="v2-pcat__first">
        <span className="v2-pcat__kicker">First thing I’ll do</span>
        <p>{card.firstThing}</p>
      </div>

      <div className="v2-pcat__sample">
        <div className="v2-pcat__sample-ask">{card.sample.ask}</div>
        <div className="v2-pcat__sample-reply">{card.sample.reply}</div>
      </div>

      <div className="v2-pcat__chips">
        {card.skills.map((skill) => (
          <span key={skill} className="v2-pcat__chip">{skill}</span>
        ))}
      </div>

      {/* The limits line always renders — a colleague that names its edges
          reads as trustworthy; one that claims everything reads as the model
          in a hat (roster card discipline). */}
      <p className="v2-pcat__limits">{card.limits}</p>

      <details className="v2-pcat__how">
        <summary>How I work</summary>
        <p>{card.howIWork}</p>
      </details>

      <footer className="v2-pcat__card-foot">
        {card.tiers.length === 1 && card.tiers[0] === 'local' && (
          <span className="v2-pcat__tier-note">Runs on your machine</span>
        )}
        {availability.cta ? (
          <button type="button" className="v2-pcat__cta" onClick={onCta}>
            {availability.cta}
          </button>
        ) : (
          <span className="v2-pcat__soon-note">Arrives with hosted seats</span>
        )}
      </footer>
    </article>
  );
};

const V2PersonaCatalog: React.FC = () => (
  <div className="v2-pcat">
    <header className="v2-pcat__head">
      <h1 className="v2-pcat__title">Hire a colleague</h1>
      <p className="v2-pcat__sub">
        Pick who joins your team. Where they run is a separate choice — and changing it later never changes who they are.
      </p>
    </header>

    <div className="v2-pcat__grid">
      {PERSONA_CARDS.map((card) => (
        <PersonaCardView key={card.key} card={card} />
      ))}
    </div>

    <footer className="v2-pcat__foot">
      <span>More colleagues are on the way.</span>
      <a className="v2-pcat__manage" href="/v2/agents/manage">Manage installed agents</a>
    </footer>
  </div>
);

export default V2PersonaCatalog;
