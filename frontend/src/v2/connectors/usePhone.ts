// True at phone width (the page's 640px breakpoint). The phone page is laid out
// differently from the wide one (one merged grid, a search icon, the filter below
// the head), so it is a render decision, not only CSS.
import { useEffect, useState } from 'react';

const QUERY = '(max-width: 640px)';

const read = (): boolean => (
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
);

export const usePhone = (): boolean => {
  const [phone, setPhone] = useState<boolean>(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(QUERY);
    const onChange = () => setPhone(list.matches);
    onChange();
    // Safari before 14 only has the old addListener pair.
    if (list.addEventListener) list.addEventListener('change', onChange); else list.addListener(onChange);
    return () => {
      if (list.removeEventListener) list.removeEventListener('change', onChange); else list.removeListener(onChange);
    };
  }, []);
  return phone;
};
