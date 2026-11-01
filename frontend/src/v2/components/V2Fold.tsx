import React, { useEffect, useRef, useState } from 'react';

// A fold body that opens and closes by size: its grid row goes 0fr <-> 1fr, so no
// pixel height is ever measured. A closing body stays mounted, inert, until the
// close animation ends; a timer backs that up so it can never stay stuck open
// (reduced motion, a hidden tab, or a browser that fires no animation events).
// Only a change the reader makes animates. The first render lands as it is.
const CLOSE_FALLBACK_MS = 200;

type V2FoldProps = {
  open: boolean;
  id?: string;
  className?: string;
  children: React.ReactNode;
};

const V2Fold: React.FC<V2FoldProps> = ({ open, id, className, children }) => {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState<'idle' | 'opening' | 'closing'>('idle');
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    if (open) {
      setRendered(true);
      setPhase('opening');
      return undefined;
    }
    setPhase('closing');
    const timer = window.setTimeout(() => {
      setRendered(false);
      setPhase('idle');
    }, CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!rendered) return null;
  const closing = phase === 'closing';
  return (
    <div
      className={`v2-fold${phase === 'idle' ? '' : ` v2-fold--${phase}`}`}
      {...(closing ? { inert: '' } : {})}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (closing) setRendered(false);
        setPhase('idle');
      }}
    >
      {/* The caller's class sits one level in, so its padding is clipped with the
          content instead of holding the 0fr row open. */}
      <div className="v2-fold__inner">
        <div id={id} className={className}>{children}</div>
      </div>
    </div>
  );
};

export default V2Fold;
