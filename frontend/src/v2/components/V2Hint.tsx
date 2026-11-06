import React, { useEffect, useId, useRef, useState } from 'react';

interface V2HintProps {
  children: React.ReactNode;
  label: string;
}

// Hover belongs to a mouse. Phones replay each tap as mouse events, so listening
// for those closed the hint as soon as the next tap landed anywhere else. On a
// phone the pod title's rename pencil is only reachable while the hint is open,
// so that mouseleave took the pencil away from under the tap meant for it. A pen
// that can't hover sends pointerenter and pointerleave around each tap, before
// the click, so anything but a mouse is left out.
const isMouse = (event: React.PointerEvent): boolean => event.pointerType === 'mouse';

const V2Hint: React.FC<V2HintProps> = ({ children, label }) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const pointerFocus = useRef(false);
  // Set when hover opened the hint. A mouse click reaches the trigger only after
  // hovering it, so toggling there closed the hint under the cursor: a desktop
  // click on "i" did nothing visible (D215 crawl, 2026-11-04). That click pins
  // the open hint instead, until blur or the next click.
  const hoverOpened = useRef(false);
  const root = useRef<HTMLSpanElement>(null);

  // A tap elsewhere closes it, because iOS doesn't focus a tapped button and so
  // never blurs one. On click, not pointerdown: the tap has to reach its target
  // before the hint closes.
  useEffect(() => {
    if (!open) return undefined;
    const closeOnClickElsewhere = (event: MouseEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      pointerFocus.current = false;
      setOpen(false);
    };
    document.addEventListener('click', closeOnClickElsewhere);
    return () => document.removeEventListener('click', closeOnClickElsewhere);
  }, [open]);

  return (
    <span
      ref={root}
      className={`v2-hint${open ? ' v2-hint--open' : ''}`}
      onPointerEnter={(event) => {
        if (!isMouse(event)) return;
        if (!pointerFocus.current && !open) { hoverOpened.current = true; setOpen(true); }
      }}
      onPointerLeave={(event) => {
        if (!isMouse(event)) return;
        hoverOpened.current = false;
        if (!pointerFocus.current) setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          pointerFocus.current = false;
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="v2-hint__trigger"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onPointerDown={() => { pointerFocus.current = true; }}
        onFocus={() => { if (!pointerFocus.current) setOpen(true); }}
        onClick={(event) => {
          if (hoverOpened.current) {
            // Pinned: leaving no longer closes it. Blur or a second click does.
            // Safari and Firefox on macOS do not focus a button on click, and a
            // button that never had focus never blurs, so take focus here.
            hoverOpened.current = false;
            pointerFocus.current = true;
            event.currentTarget.focus();
            setOpen(true);
            return;
          }
          setOpen((value) => !value);
          pointerFocus.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            event.currentTarget.blur();
          }
        }}
      >i</button>
      <span id={id} className="v2-hint__content">{children}</span>
    </span>
  );
};

export default V2Hint;
