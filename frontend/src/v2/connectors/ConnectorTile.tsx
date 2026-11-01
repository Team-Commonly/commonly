// One tile of the connectors grid (d215 "a logo grid"). The logo carries the name;
// state is a corner mark: a status dot, a lock for admin-only, "beta" for read in
// testing. Descriptions are reveal-only, so the tile holds none.
import React from 'react';
import ConnectorLogo from './ConnectorLogo';

export type TileDot = 'live' | 'idle' | 'pending' | 'attention';

interface Props {
  type: string;
  name: string;
  /** What the corner dot means, in words: it is the dot's accessible name. */
  dot?: { kind: TileDot; label: string; pulse?: boolean };
  /** An admin-only connector: a lock, with the sentence as its title. */
  lock?: string;
  /** A "beta" mark, with what it means as its title. */
  beta?: { word: string; title: string };
  /** Greyed: not offered here. */
  dim?: boolean;
  /** The dashed "add" tile: a plus where the logo goes. */
  add?: boolean;
  selected?: boolean;
  expanded?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

const ConnectorTile = React.forwardRef<HTMLButtonElement, Props>(({
  type, name, dot, lock, beta, dim, add, selected, expanded, onClick,
}, ref) => (
  <button
    ref={ref}
    type="button"
    className={`v2-cx-tile${dim ? ' v2-cx-tile--dim' : ''}${add ? ' v2-cx-tile--add' : ''}${selected ? ' v2-cx-tile--selected' : ''}`}
    title={name}
    aria-haspopup="dialog"
    aria-expanded={expanded === undefined ? undefined : expanded}
    aria-pressed={selected === undefined ? undefined : selected}
    onClick={onClick}
  >
    <span className="v2-cx-tile__state">
      {beta && <span className="v2-cx-tile__beta" title={beta.title}>{beta.word}</span>}
      {lock && (
        <span className="v2-cx-tile__lock" title={lock} role="img" aria-label={lock}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </span>
      )}
      {dot && (
        <span
          className={`v2-cx-tile__dot v2-cx-tile__dot--${dot.kind}${dot.pulse ? ' v2-cx-tile__dot--pulse' : ''}`}
          title={dot.label}
          role="img"
          aria-label={dot.label}
        />
      )}
    </span>
    <span className="v2-cx-tile__logo">
      {add ? (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg>
      ) : <ConnectorLogo type={type} />}
    </span>
    <span className="v2-cx-tile__name">{name}</span>
  </button>
));
ConnectorTile.displayName = 'ConnectorTile';

export default ConnectorTile;
