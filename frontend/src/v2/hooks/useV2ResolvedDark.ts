import { useEffect, useState } from 'react';
import { resolvedV2Dark } from '../utils/theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

const readDark = (): boolean => resolvedV2Dark(
  document.documentElement.getAttribute('data-v2-theme'),
  typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches,
);

// Whether v2 paints dark right now. Follows the data-v2-theme attribute that
// setV2Theme writes and the OS scheme, so a change in Settings reaches the
// MUI theme without a reload.
export const useV2ResolvedDark = (): boolean => {
  const [dark, setDark] = useState(readDark);

  useEffect(() => {
    const sync = () => setDark(readDark());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-v2-theme'] });
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
    media?.addEventListener?.('change', sync);
    sync();
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', sync);
    };
  }, []);

  return dark;
};
