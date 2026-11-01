import { useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

// A disclosure that opens by itself when something needs the reader (an error, a
// key to copy, a confirm) and stays a working toggle afterwards. Rendering it as
// `open || demand` instead pins it open, so its toggle does nothing for as long
// as the demand holds.
//
// Each demand opens the panel on its own rising edge, not on the OR of them: a
// key that arrives while a confirm already held the panel open, after the reader
// closed it, must still open it. The layout effect opens it before paint.
export const useOpensOnDemand = (...demands: unknown[]): [boolean, Dispatch<SetStateAction<boolean>>] => {
  const [open, setOpen] = useState(() => demands.some(Boolean));
  const previous = useRef(demands.map(Boolean));
  useLayoutEffect(() => {
    const now = demands.map(Boolean);
    if (now.some((demand, index) => demand && !previous.current[index])) setOpen(true);
    previous.current = now;
  });
  return [open, setOpen];
};
