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

// Whether the CSS paints dark for this attribute value. An explicit 'light' or
// 'dark' wins; 'auto' or no attribute follows the OS, as v2.css does.
export function resolvedV2Dark(attr: string | null, systemPrefersDark: boolean): boolean {
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return systemPrefersDark;
}

export function applyV2Theme(pref: V2ThemePref): void {
  document.documentElement.setAttribute('data-v2-theme', pref);
}

const listeners = new Set<() => void>();

// Lets every mounted control (the Settings picker, the rail switch) follow the
// one stored preference instead of keeping a copy of it.
// It also fires when the OS flips light/dark, so an 'auto' preference stays current.
export function subscribeV2Theme(listener: () => void): () => void {
  listeners.add(listener);
  const mql = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;
  mql?.addEventListener?.('change', listener);
  return () => {
    listeners.delete(listener);
    mql?.removeEventListener?.('change', listener);
  };
}

// 'auto' follows the OS; the rail switch needs the set actually showing.
export function resolveV2Theme(pref: V2ThemePref): 'light' | 'dark' {
  if (pref !== 'auto') return pref;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light';
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

export function setV2Theme(pref: V2ThemePref): void {
  try {
    window.localStorage.setItem(V2_THEME_KEY, pref);
  } catch {
    // Storage can be blocked; the choice still applies for this page view.
  }
  // The whole page crossfades once where the browser has view transitions and the
  // user hasn't asked for reduced motion. Everywhere else the switch is instant.
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const doc = document as ViewTransitionDocument;
  if (doc.startViewTransition && !reduce) {
    doc.startViewTransition(() => applyV2Theme(pref));
  } else {
    applyV2Theme(pref);
  }
  // Subscribers (the theme switch, the Settings picker) hear every change,
  // whichever way it was painted.
  listeners.forEach((listener) => listener());
}
