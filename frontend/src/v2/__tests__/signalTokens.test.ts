import fs from 'fs';
import path from 'path';

// TASK-730 (D223): the Signal primitives come from the d215 artboard. These
// tests keep v2.css's light set and both dark sets carrying every token, pin
// each artboard value per set, and keep the design-system mirror in step.

const css = fs.readFileSync(path.join(__dirname, '../v2.css'), 'utf8');

// The light set is the first .v2-root block; the dark selector and the
// prefers-color-scheme block follow it. The media block ends at the first
// column-zero closing brace after its start (its inner rules are indented).
const lightStart = css.indexOf('.v2-root {');
const darkStart = css.indexOf(':root[data-v2-theme="dark"] .v2-root {');
const mediaStart = css.indexOf('@media (prefers-color-scheme: dark)');
const mediaEnd = css.indexOf('\n}\n', mediaStart) + 3;
const light = css.slice(lightStart, darkStart);
const dark = css.slice(darkStart, mediaStart);
const media = css.slice(mediaStart, mediaEnd);

const valueIn = (block: string, name: string): string | undefined => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  return m ? m[1].trim() : undefined;
};

// Artboard values (docs/design/artboards/d215/index.html :root and dark blocks).
const ARTBOARD: Record<string, { light: string; dark: string }> = {
  'v2-ink-2': { light: '#1d2433', dark: '#d3d8e1' },
  'v2-fill-a': { light: '#333c4e', dark: '#f4f5f8' },
  'v2-fill-b': { light: '#161d2c', dark: '#dce0e8' },
  'v2-fill-edge': { light: '#0b101b', dark: '#c4cad5' },
  'v2-on-fill': { light: '#ffffff', dark: '#0b0e13' },
  'v2-accent-fill-a': { light: '#2e50e2', dark: '#3d5ef2' },
  'v2-accent-fill-b': { light: '#1b3bc6', dark: '#2948d8' },
  'v2-key-a': { light: '#ffffff', dark: '#1e2531' },
  'v2-key-b': { light: '#f4f5f7', dark: '#191f29' },
  'v2-key-edge': { light: 'rgba(15, 23, 42, 0.14)', dark: 'rgba(255, 255, 255, 0.10)' },
  'v2-key-inset': {
    light: 'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 1px 2px rgba(16, 24, 40, 0.06)',
    dark: 'inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 1px 2px rgba(0, 0, 0, 0.3)',
  },
  'v2-shadow-pane': {
    light: '0 0 0 1px rgba(16, 24, 40, 0.07), 0 1px 2px rgba(16, 24, 40, 0.04), 0 12px 28px -20px rgba(16, 24, 40, 0.18)',
    dark: '0 0 0 1px rgba(255, 255, 255, 0.06), 0 12px 28px -20px rgba(0, 0, 0, 0.6)',
  },
  'v2-shadow-pop': {
    light: '0 0 0 1px rgba(16, 24, 40, 0.08), 0 2px 4px rgba(16, 24, 40, 0.04), 0 18px 36px -14px rgba(16, 24, 40, 0.28)',
    dark: '0 0 0 1px rgba(255, 255, 255, 0.10), 0 18px 36px -14px rgba(0, 0, 0, 0.75)',
  },
  'v2-av-ring': { light: 'rgba(16, 24, 40, 0.07)', dark: 'rgba(255, 255, 255, 0.10)' },
  'v2-scrim': { light: 'rgba(16, 24, 40, 0.18)', dark: 'rgba(0, 0, 0, 0.45)' },
};
const SCALE = { 'v2-r-6': '6px', 'v2-r-8': '8px', 'v2-r-9': '9px', 'v2-r-10': '10px', 'v2-r-12': '12px', 'v2-r-14': '14px' };

describe('D223 Signal tokens in v2.css', () => {
  test('the light set defines every Signal token', () => {
    [...Object.keys(ARTBOARD), ...Object.keys(SCALE), 'v2-font-display'].forEach((name) => {
      expect({ name, value: valueIn(light, name) }).toEqual({ name, value: expect.any(String) });
    });
  });

  test('the light set matches the artboard light values', () => {
    Object.entries(ARTBOARD).forEach(([name, v]) => {
      expect({ name, value: valueIn(light, name) }).toEqual({ name, value: v.light });
    });
  });

  test('the dark selector and the prefers-color-scheme set each match the artboard dark values', () => {
    Object.entries(ARTBOARD).forEach(([name, v]) => {
      expect({ name, value: valueIn(dark, name) }).toEqual({ name, value: v.dark });
      expect({ name, value: valueIn(media, name) }).toEqual({ name, value: v.dark });
    });
  });

  test('the prefers-color-scheme block is bounded and holds no tokens from later in the file', () => {
    expect(media.endsWith('\n}\n')).toBe(true);
    expect(media).not.toContain('.v2-root {\n  /*');
  });

  test('design-system/tokens.css mirrors the light Signal tokens under the --c- names', () => {
    const ds = fs.readFileSync(path.join(__dirname, '../../../design-system/tokens.css'), 'utf8');
    Object.keys(ARTBOARD).forEach((v2) => {
      const dsName = v2.replace(/^v2-/, 'c-');
      expect({ name: dsName, value: valueIn(ds, dsName) }).toEqual({ name: dsName, value: valueIn(light, v2) });
    });
    Object.entries(SCALE).forEach(([v2, px]) => {
      const dsName = v2.replace(/^v2-/, 'c-');
      expect({ name: dsName, value: valueIn(ds, dsName) }).toEqual({ name: dsName, value: px });
    });
  });

  test('the change is additive: old radius and shadow aliases keep their values', () => {
    expect(valueIn(light, 'v2-radius-sm')).toBe('4px');
    expect(valueIn(light, 'v2-radius')).toBe('4px');
    expect(valueIn(light, 'v2-radius-lg')).toBe('6px');
    expect(valueIn(light, 'v2-radius-pill')).toBe('999px');
    expect(valueIn(light, 'v2-shadow-sm')).toBe('none');
    expect(valueIn(light, 'v2-shadow')).toBe('none');
    expect(valueIn(light, 'v2-shadow-lg')).toBe('none');
  });
});

// TASK-681: three surfaces were hard-coded to light values and vanished in dark.
describe('dark-safe surfaces (TASK-681)', () => {
  const rd = (rel: string): string =>
    fs.readFileSync(path.join(__dirname, rel), 'utf8');
  test('the sticky landing and agent-profile bars follow --v2-bg, not white', () => {
    [rd('../landing/v2-landing.css'), rd('../agents/v2-agent-profile.css')].forEach((css) => {
      expect(css).not.toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.86\)/);
    });
    expect(rd('../landing/v2-landing.css')).toMatch(/\.v2-landing__bar\s*\{[^}]*color-mix\(in srgb, var\(--v2-bg\) 86%/);
    expect(rd('../agents/v2-agent-profile.css')).toMatch(/\.v2-aprofile__bar\s*\{[^}]*color-mix\(in srgb, var\(--v2-bg\) 86%/);
  });
  test('ink primary buttons take theme tokens, never a literal colour', () => {
    // R06 lifted Your team onto the d215 frame: Hire and Answer are its ink
    // key, the --v2-fill-* gradient with --v2-on-fill text, in the page's sheet.
    const css = rd('../components/V2YourTeamPage.css');
    const rule = css.match(/\n\.v2-team \.v2-team__hire, \.v2-team \.v2-team-card__answer \{[^}]*\}/);
    expect(rule?.[0]).toContain('background: linear-gradient(180deg, var(--v2-fill-a), var(--v2-fill-b))');
    expect(rule?.[0]).toContain('color: var(--v2-on-fill)');
    expect(rule?.[0]).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
  test('the board drawer scrim is --v2-scrim', () => {
    // S4: the board's rules live in its own sheet; the scrim backs the phone sheet.
    expect(rd('../components/V2PodBoard.css')).toMatch(/\.v2-board__overlay\s*\{\s*background:\s*var\(--v2-scrim\)/);
  });
});
