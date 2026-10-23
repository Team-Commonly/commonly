import React, { useId, useRef, useState } from 'react';

interface V2HintProps {
  children: React.ReactNode;
  label: string;
}

const V2Hint: React.FC<V2HintProps> = ({ children, label }) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const pointerFocus = useRef(false);

  return (
    <span
      className={`v2-hint${open ? ' v2-hint--open' : ''}`}
      onMouseEnter={() => { if (!pointerFocus.current) setOpen(true); }}
      onMouseLeave={() => { if (!pointerFocus.current) setOpen(false); }}
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
