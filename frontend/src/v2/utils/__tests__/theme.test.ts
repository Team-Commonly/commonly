import fs from 'fs';
import path from 'path';
import { applyV2Theme, getV2Theme, setV2Theme, V2_THEME_KEY } from '../theme';

const v2css = fs.readFileSync(path.join(__dirname, '../../v2.css'), 'utf8');

describe('v2 appearance preference (D216)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-v2-theme');
  });

  test('defaults to auto when nothing is stored', () => {
    expect(getV2Theme()).toBe('auto');
  });

  test('ignores a stored value that is not a known preference', () => {
    window.localStorage.setItem(V2_THEME_KEY, 'midnight');
    expect(getV2Theme()).toBe('auto');
  });

  test('setV2Theme stores the choice and sets the html attribute the CSS reads', () => {
    setV2Theme('dark');
    expect(window.localStorage.getItem(V2_THEME_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-v2-theme')).toBe('dark');
    expect(getV2Theme()).toBe('dark');
  });

  test('applyV2Theme on load restores a stored light choice without writing storage', () => {
    window.localStorage.setItem(V2_THEME_KEY, 'light');
    applyV2Theme(getV2Theme());
    expect(document.documentElement.getAttribute('data-v2-theme')).toBe('light');
  });

  test('v2.css carries the D216 dark set for both explicit dark and auto', () => {
    expect(v2css).toContain(':root[data-v2-theme="dark"] .v2-root {');
    expect(v2css).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-v2-theme="light"]) .v2-root {');
    expect(v2css).toMatch(/:root\[data-v2-theme="dark"\] \.v2-root \{[\s\S]*?--v2-text-primary: #e8ebf1;/);
  });

  test('the explicit and auto dark blocks declare the same tokens (ux-lead ruling, 4)', () => {
    const explicit = v2css.match(/:root\[data-v2-theme="dark"\] \.v2-root \{([\s\S]*?)\n\}/);
    const auto = v2css.match(/:root:not\(\[data-v2-theme="light"\]\) \.v2-root \{([\s\S]*?)\n  \}/);
    expect(explicit).not.toBeNull();
    expect(auto).not.toBeNull();
    const decls = (body: string) =>
      body.split(';').map((d) => d.trim()).filter((d) => d.startsWith('--') || d.startsWith('color-scheme'));
    expect(decls(auto![1])).toEqual(decls(explicit![1]));
    expect(decls(explicit![1])).toContain('--v2-focus-ring: 0 0 0 2px var(--v2-bg), 0 0 0 4px #8aa2ff');
  });

  test('setV2Theme crossfades inside a view transition when the browser supports it (TASK-700)', () => {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    const startViewTransition = jest.fn((cb: () => void) => cb());
    doc.startViewTransition = startViewTransition as unknown as Document['startViewTransition'];
    try {
      setV2Theme('dark');
      expect(startViewTransition).toHaveBeenCalledTimes(1);
      expect(document.documentElement.getAttribute('data-v2-theme')).toBe('dark');
    } finally {
      delete doc.startViewTransition;
    }
  });

  test('setV2Theme skips the crossfade under reduced motion and without the API', () => {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    const startViewTransition = jest.fn((cb: () => void) => cb());
    doc.startViewTransition = startViewTransition as unknown as Document['startViewTransition'];
    const original = window.matchMedia;
    window.matchMedia = jest.fn().mockImplementation((q: string) => ({ matches: q.includes('reduce'), media: q })) as unknown as typeof window.matchMedia;
    try {
      setV2Theme('light');
      expect(startViewTransition).not.toHaveBeenCalled();
      expect(document.documentElement.getAttribute('data-v2-theme')).toBe('light');
    } finally {
      window.matchMedia = original;
      delete doc.startViewTransition;
    }
    setV2Theme('dark');
    expect(document.documentElement.getAttribute('data-v2-theme')).toBe('dark');
  });

  test('v2.css declares the motion tokens and one global reduced-motion switch (TASK-700)', () => {
    expect(v2css).toContain('--v2-dur-fast: 120ms;');
    expect(v2css).toContain('--v2-dur: 200ms;');
    expect(v2css).toContain('--v2-dur-slow: 320ms;');
    expect(v2css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n  \*,[\s\S]*?animation-duration: 0\.01ms !important;/);
  });

  test('index.html applies a stored Light or Dark choice before first paint (code-gate HOLD, rhea)', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../../../index.html'), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain(`getItem('${V2_THEME_KEY}')`);
    expect(head).toContain("v2Theme === 'light' || v2Theme === 'dark'");
    expect(head).toContain("setAttribute('data-v2-theme', v2Theme)");
  });
});
