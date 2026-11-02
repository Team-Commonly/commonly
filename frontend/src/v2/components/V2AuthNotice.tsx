import React from 'react';
import { ShellGlyph } from '../icons/glyphs';

// The one message row on every auth card, drawn in the d215 sign-in and
// sign-up frames: an alert for a failure, a status for a confirmation. The
// tint is the same; the glyph and the role tell them apart, never a colour.
const V2AuthNotice: React.FC<{ kind?: 'alert' | 'status'; children: React.ReactNode }> = ({
  kind = 'alert', children,
}) => (
  <div className="v2-login__notice" role={kind}>
    <ShellGlyph name={kind === 'alert' ? 'alert' : 'check'} />
    <span>{children}</span>
  </div>
);

export default V2AuthNotice;
