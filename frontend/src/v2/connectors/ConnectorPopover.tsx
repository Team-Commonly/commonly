// The reveal for an unconnected tile (d215): logo and name, the sentence, the tool
// names as small chips, and the act. It is anchored under its tile on a wide
// screen and is a bottom sheet at phone width, where there is no hover to reach it.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Props {
  /** The tile the popover opens from; focus returns to it on close. */
  anchor: HTMLElement | null;
  /** The positioned element the popover is placed inside. */
  container: HTMLElement | null;
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}

const WIDTH = 300;
const GAP = 8;

const ConnectorPopover: React.FC<Props> = ({ anchor, container, label, onClose, children }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !container) return;
    const a = anchor.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    const left = Math.min(Math.max(0, a.left - c.left + a.width / 2 - WIDTH / 2), Math.max(0, c.width - WIDTH));
    setPlace({ top: a.bottom - c.top + container.scrollTop + GAP, left: left + container.scrollLeft });
  }, [anchor, container]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [anchor, onClose]);

  // Focus moves in on open and back to the tile on close.
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('button, a[href]');
    first?.focus();
    return () => { anchor?.focus(); };
  }, [anchor]);

  return (
    <div
      ref={ref}
      className="v2-cx-pop"
      role="dialog"
      aria-label={label}
      style={place ? { top: place.top, left: place.left } : undefined}
    >
      {children}
    </div>
  );
};

export default ConnectorPopover;
