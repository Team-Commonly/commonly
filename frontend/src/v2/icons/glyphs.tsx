// Glyphs — categories are marks (Sam, 2026-09-11, "Signal, quieter" direction A).
// Anything with a fixed set of values renders as one of these, 16px, 2px stroke,
// currentColor, never a unicode character. The rail's icons set the style.
import React from 'react';

const G: React.FC<{ children: React.ReactNode; size?: number }> = ({ children, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export type AskKind = 'mention' | 'approval' | 'decision' | 'handoff' | 'press';

/** The four ask kinds (plus press) as marks. */
export const KindGlyph: React.FC<{ kind: AskKind | string; size?: number }> = ({ kind, size }) => {
  switch (kind) {
    case 'mention':
      return <G size={size}><circle cx="12" cy="12" r="4" /><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-5.3 8.2" /></G>;
    case 'approval':
      return <G size={size}><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></G>;
    case 'decision':
      return <G size={size}><path d="M6 3v6a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V3M12 13v8" /></G>;
    case 'handoff':
      return <G size={size}><path d="M17 3l4 4-4 4M3 7h18M7 21l-4-4 4-4M21 17H3" /></G>;
    case 'press':
      return <G size={size}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="12" r="3" /><path d="M8.6 7.5 15.4 10.5M8.6 16.5l6.8-3" /></G>;
    default:
      return <G size={size}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01" /></G>;
  }
};

export type ActName = 'handled' | 'deny' | 'open' | 'manage';

/** Secondary acts: the word lives in aria-label and title; the button shows the glyph. */
export const ActGlyph: React.FC<{ name: ActName; size?: number }> = ({ name, size }) => {
  switch (name) {
    case 'handled':
      return <G size={size}><path d="M20 6 9 17l-5-5" /></G>;
    case 'deny':
      return <G size={size}><path d="M18 6 6 18M6 6l12 12" /></G>;
    case 'manage':
      return <G size={size}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></G>;
    default:
      return <G size={size}><path d="M7 17 17 7M8 7h9v9" /></G>;
  }
};

export type MarkName = 'attention' | 'mirror' | 'off';

/** Relay mode on a channel row: a category, so a mark; the sentence lives in title and aria-label. */
export const MarkGlyph: React.FC<{ name: MarkName; size?: number }> = ({ name, size }) => {
  switch (name) {
    case 'attention':
      return <G size={size}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></G>;
    case 'mirror':
      return <G size={size}><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" /></G>;
    default:
      return <G size={size}><path d="M8.6 8.6A6 6 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.3-5M13.7 21a2 2 0 0 1-3.4 0M3 3l18 18" /></G>;
  }
};
