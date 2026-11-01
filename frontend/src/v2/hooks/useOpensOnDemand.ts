import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

// A disclosure that opens by itself when `demand` turns true (an error, a key to
// copy, a confirm) and stays a working toggle afterwards. Rendering it as
// `open || demand` instead pins it open, so its toggle does nothing for as long
// as the demand holds.
export const useOpensOnDemand = (demand: boolean): [boolean, Dispatch<SetStateAction<boolean>>] => {
  const [open, setOpen] = useState(demand);
  useEffect(() => { if (demand) setOpen(true); }, [demand]);
  return [open, setOpen];
};
