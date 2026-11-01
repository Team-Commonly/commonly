// Glyphs — categories are marks ("Signal, quieter" direction A).
// Anything with a fixed set of values renders as one of these, 16px, 2px stroke,
// currentColor, never a unicode character. The rail's icons set the style.
import React from 'react';

const G: React.FC<{ children: React.ReactNode; size?: number }> = ({ children, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export type AskKind = 'mention' | 'approval' | 'decision' | 'handoff' | 'blocked' | 'press';

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
    case 'blocked':
      return <G size={size}><path d="M4 4v16M20 4v16M9 8v8M15 8v8" /></G>;
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

export type ShellGlyphName = 'pencil' | 'people' | 'gear' | 'board' | 'pin' | 'inbox' | 'agents' | 'file' | 'lock' | 'search' | 'plus' | 'reply' | 'chevron';

/** D215 sidebar controls (TASK-691): the icon carries the act, aria-label and title carry the word. */
export const ShellGlyph: React.FC<{ name: ShellGlyphName; size?: number }> = ({ name, size }) => {
  switch (name) {
    case 'pencil':
      return <G size={size}><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></G>;
    case 'people':
      return <G size={size}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></G>;
    case 'gear':
      return <ActGlyph name="manage" size={size} />;
    case 'board':
      return <G size={size}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 7v7M12 7v4M16 7v9" /></G>;
    case 'pin':
      return <G size={size}><path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" /></G>;
    case 'inbox':
      return <G size={size}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" /></G>;
    case 'agents':
      return <G size={size}><path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5M6 6l3.5 3.5M14.5 14.5 18 18M18 6l-3.5 3.5M9.5 14.5 6 18" /></G>;
    case 'file':
      return <G size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8" /></G>;
    case 'lock':
      return <G size={size}><rect x="4" y="11" width="16" height="10" rx="2.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></G>;
    case 'search':
      return <G size={size}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></G>;
    case 'plus':
      return <G size={size}><path d="M12 5v14M5 12h14" /></G>;
    case 'reply':
      return <G size={size}><path d="M9 17 4 12l5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></G>;
    default:
      return <G size={size}><path d="m6 9 6 6 6-6" /></G>;
  }
};
