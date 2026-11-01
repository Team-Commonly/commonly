// True at phone width (by default the connectors page's 640px breakpoint; a page
// with another breakpoint passes its own query). The phone page is laid out
// differently from the wide one (one merged grid, a search icon, the filter below
// the head), so it is a render decision, not only CSS.
import { useEffect, useState } from 'react';

const QUERY = '(max-width: 640px)';

const read = (query: string): boolean => (
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
);

export const usePhone = (query: string = QUERY): boolean => {
  const [phone, setPhone] = useState<boolean>(() => read(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setPhone(list.matches);
    onChange();
    // Safari before 14 only has the old addListener pair.
    if (list.addEventListener) list.addEventListener('change', onChange); else list.addListener(onChange);
    return () => {
      if (list.removeEventListener) list.removeEventListener('change', onChange); else list.removeListener(onChange);
    };
  }, [query]);
  return phone;
};
