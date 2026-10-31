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

export function setV2Theme(pref: V2ThemePref): void {
  try {
    window.localStorage.setItem(V2_THEME_KEY, pref);
  } catch {
    // Storage can be blocked; the choice still applies for this page view.
  }
  applyV2Theme(pref);
}
