import React, { useEffect, useState } from 'react';
import { ShellGlyph } from '../icons/glyphs';

// The one message row on every auth card, drawn in the d215 sign-in and
// sign-up frames: an alert for a failure, a status for a confirmation. The
// tint is the same; the glyph and the role tell them apart, never a colour.
// A status region is announced when its content changes, not for content it
// mounts with, so a status row mounts empty and takes its text a frame later.
const V2AuthNotice: React.FC<{ kind?: 'alert' | 'status'; children: React.ReactNode }> = ({
  kind = 'alert', children,
}) => {
  const [filled, setFilled] = useState(kind === 'alert');
  useEffect(() => {
    if (kind !== 'status') { setFilled(true); return undefined; }
    const frame = window.requestAnimationFrame(() => setFilled(true));
    return () => window.cancelAnimationFrame(frame);
  }, [kind]);
  return (
    <div className="v2-login__notice" role={kind}>
      <ShellGlyph name={kind === 'alert' ? 'alert' : 'check'} />
      <span>{filled ? children : null}</span>
    </div>
  );
};

export default V2AuthNotice;
