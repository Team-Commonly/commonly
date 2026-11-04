import React, { useId, useRef, useState } from 'react';

interface V2HintProps {
  children: React.ReactNode;
  label: string;
}

const V2Hint: React.FC<V2HintProps> = ({ children, label }) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const pointerFocus = useRef(false);
  // Set when hover opened the hint. A mouse click reaches the trigger only after
  // hovering it, so toggling there closed the hint under the cursor: a desktop
  // click on "i" did nothing visible (D215 crawl, 2026-11-04). That click pins
  // the open hint instead, until blur or the next click.
  const hoverOpened = useRef(false);

  return (
    <span
      className={`v2-hint${open ? ' v2-hint--open' : ''}`}
      onMouseEnter={() => { if (!pointerFocus.current && !open) { hoverOpened.current = true; setOpen(true); } }}
      onMouseLeave={() => { hoverOpened.current = false; if (!pointerFocus.current) setOpen(false); }}
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
        onClick={() => {
          if (hoverOpened.current) {
            // Pinned: leaving no longer closes it. Blur or a second click does.
            hoverOpened.current = false;
            pointerFocus.current = true;
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
