// D216 appearance preference for v2. 'auto' follows the OS (the default when
// nothing is stored); 'light' and 'dark' force a set. The choice lives on the
// <html> element as data-v2-theme, and the CSS in v2.css reads it.
export type V2ThemePref = 'auto' | 'light' | 'dark';

export const V2_THEME_KEY = 'v2.theme';
export const V2_THEMES: readonly V2ThemePref[] = ['auto', 'light', 'dark'];

export function getV2Theme(): V2ThemePref {
  try {
    const stored = window.localStorage.getItem(V2_THEME_KEY);
    return (V2_THEMES as readonly string[]).includes(stored || '') ? (stored as V2ThemePref) : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyV2Theme(pref: V2ThemePref): void {
  document.documentElement.setAttribute('data-v2-theme', pref);
}

const listeners = new Set<() => void>();

// Lets every mounted control (the Settings picker, the rail switch) follow the
// one stored preference instead of keeping a copy of it.
export function subscribeV2Theme(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// 'auto' follows the OS; the rail switch needs the set actually showing.
export function resolveV2Theme(pref: V2ThemePref): 'light' | 'dark' {
  if (pref !== 'auto') return pref;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light';
}

export function setV2Theme(pref: V2ThemePref): void {
  try {
    window.localStorage.setItem(V2_THEME_KEY, pref);
  } catch {
    // Storage can be blocked; the choice still applies for this page view.
  }
  applyV2Theme(pref);
  listeners.forEach((listener) => listener());
}
