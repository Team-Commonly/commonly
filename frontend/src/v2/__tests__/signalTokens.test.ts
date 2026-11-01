import fs from 'fs';
import path from 'path';

// TASK-730 (D223): the Signal primitives come from the d215 artboard. These
// tests keep v2.css's light set and both dark sets carrying every token, and
// pin the values that the artboard's light/dark pairs depend on.

const css = fs.readFileSync(path.join(__dirname, '../v2.css'), 'utf8');

// The light set is the first .v2-root block; the two dark sets follow it.
const lightStart = css.indexOf('.v2-root {');
const darkStart = css.indexOf(':root[data-v2-theme="dark"] .v2-root {');
const mediaStart = css.indexOf('@media (prefers-color-scheme: dark)');
const light = css.slice(lightStart, darkStart);
const dark = css.slice(darkStart, mediaStart);
const media = css.slice(mediaStart);

const valueIn = (block: string, name: string): string | undefined => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  return m ? m[1].trim() : undefined;
};

const COLOR_TOKENS = [
  'v2-ink-2', 'v2-fill-a', 'v2-fill-b', 'v2-fill-edge', 'v2-on-fill',
  'v2-accent-fill-a', 'v2-accent-fill-b', 'v2-key-a', 'v2-key-b', 'v2-key-edge',
  'v2-av-ring', 'v2-scrim',
];
const SHADOW_TOKENS = ['v2-key-inset', 'v2-shadow-pane', 'v2-shadow-pop'];
const SCALE_TOKENS = ['v2-r-6', 'v2-r-8', 'v2-r-9', 'v2-r-10', 'v2-r-12', 'v2-r-14'];
const ALL_TOKENS = [...COLOR_TOKENS, ...SHADOW_TOKENS, ...SCALE_TOKENS, 'v2-font-display'];

describe('D223 Signal tokens in v2.css', () => {
  test('the light set defines every Signal token', () => {
    ALL_TOKENS.forEach((name) => {
      expect({ name, value: valueIn(light, name) }).toEqual({ name, value: expect.any(String) });
    });
  });

  test('the dark selector and the prefers-color-scheme set each define every colour and shadow token', () => {
    [...COLOR_TOKENS, ...SHADOW_TOKENS].forEach((name) => {
      expect({ name, value: valueIn(dark, name) }).toEqual({ name, value: expect.any(String) });
      expect({ name, value: valueIn(media, name) }).toEqual({ name, value: expect.any(String) });
    });
  });

  test('the light and dark values for the artboard pairs match the artboard', () => {
    expect(valueIn(light, 'v2-scrim')).toBe('rgba(16, 24, 40, 0.18)');
    expect(valueIn(dark, 'v2-scrim')).toBe('rgba(0, 0, 0, 0.45)');
    expect(valueIn(light, 'v2-fill-a')).toBe('#333c4e');
    expect(valueIn(dark, 'v2-fill-a')).toBe('#f4f5f8');
    expect(valueIn(light, 'v2-accent-fill-a')).toBe('#2e50e2');
    expect(valueIn(dark, 'v2-accent-fill-a')).toBe('#3d5ef2');
    expect(valueIn(media, 'v2-accent-fill-a')).toBe('#3d5ef2');
  });

  test('the radius scale is additive: the old --v2-radius-* aliases keep their values', () => {
    expect(valueIn(light, 'v2-radius-sm')).toBe('4px');
    expect(valueIn(light, 'v2-radius-lg')).toBe('6px');
    expect(valueIn(light, 'v2-r-8')).toBe('8px');
    expect(valueIn(light, 'v2-r-14')).toBe('14px');
  });
});
