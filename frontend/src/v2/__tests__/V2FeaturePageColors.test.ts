import fs from 'fs';
import path from 'path';
import { V2_COLORS, V2_DARK_COLORS } from '../components/V2FeaturePage';
import { resolvedV2Dark } from '../utils/theme';

// TASK-681/685: V2FeaturePage's MUI theme cannot read var(), so its colours stay
// literal, in a light set and a dark set. This pins each literal to the --v2-*
// token of the same role in its mode, so a token change fails here instead of
// drifting silently.
const css = fs.readFileSync(path.join(__dirname, '../v2.css'), 'utf8');

const TOKEN_FOR: Record<keyof typeof V2_COLORS, string> = {
  bg: 'bg-subtle',
  surface: 'surface',
  surfaceHover: 'surface-hover',
  border: 'border',
  borderSoft: 'border-soft',
  borderStrong: 'border-strong',
  textPrimary: 'text-primary',
  textSecondary: 'text-secondary',
  textMuted: 'text-muted',
  accent: 'accent',
  accentStrong: 'accent-strong',
  accentSoft: 'accent-soft',
  onAccent: 'on-accent',
  accentFill: 'accent-fill',
  accentFillHover: 'accent-strong',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  shadowSm: '',
  shadow: '',
  shadowLg: '',
};

const valueIn = (block: string, name: string): string | null => {
  const m = new RegExp(`--v2-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block);
  return m ? m[1].toLowerCase() : null;
};

// A block runs from its selector to the first closing brace; neither block nests one.
const blockOf = (selector: string): string => {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no block for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

const darkBlock = blockOf(':root[data-v2-theme="dark"] .v2-root {');
const darkTwinBlock = blockOf(':root:not([data-v2-theme="light"]) .v2-root {');

// Where a role takes a different token in dark. The filled button's hover is
// accent-strong in light, but dark's accent-strong is the fill itself, so dark
// hovers on accent-deep.
const DARK_TOKEN_FOR: Partial<Record<keyof typeof V2_COLORS, string>> = {
  accentFillHover: 'accent-deep',
};
const darkTokenFor = (key: keyof typeof V2_COLORS): string => DARK_TOKEN_FOR[key] ?? TOKEN_FOR[key];

// First declaration wins: the light block sits above the dark scopes.
const lightTokenValue = (name: string): string | null => valueIn(css, name);

// A name the dark block leaves out inherits its light value, so the light value is
// the dark one for it. That is how the status solids reach dark mode.
const darkTokenValue = (name: string): string | null => valueIn(darkBlock, name) ?? lightTokenValue(name);

const colourKeys = (Object.keys(TOKEN_FOR) as Array<keyof typeof V2_COLORS>)
  .filter((k) => TOKEN_FOR[k] !== '');

describe('V2FeaturePage MUI palette matches the --v2-* tokens', () => {
  test.each(colourKeys)('light %s equals its light token', (key) => {
    expect(lightTokenValue(TOKEN_FOR[key])).not.toBeNull();
    expect(V2_COLORS[key].toLowerCase()).toBe(lightTokenValue(TOKEN_FOR[key]));
  });

  test.each(colourKeys)('dark %s equals its dark token, or the light one where dark inherits it', (key) => {
    expect(V2_DARK_COLORS[key].toLowerCase()).toBe(darkTokenValue(darkTokenFor(key)));
  });

  test('the dark block and its prefers-color-scheme twin agree', () => {
    // The twin paints when no attribute is set, so a drift between the two would
    // show dark on one path and not the other.
    colourKeys.forEach((key) => {
      expect(valueIn(darkTwinBlock, darkTokenFor(key))).toBe(valueIn(darkBlock, darkTokenFor(key)));
    });
  });
});

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('a filled primary button keeps its text readable', () => {
  test.each([['light', V2_COLORS], ['dark', V2_DARK_COLORS]] as const)('%s fill and hover give onAccent at least 4.5:1, and the hover differs', (_mode, c) => {
    expect(contrast(c.onAccent, c.accentFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.onAccent, c.accentFillHover)).toBeGreaterThanOrEqual(4.5);
    expect(c.accentFillHover).not.toBe(c.accentFill);
  });
});

describe('resolvedV2Dark follows an explicit attribute, then the OS', () => {
  test('an explicit light or dark wins over the OS', () => {
    expect(resolvedV2Dark('dark', false)).toBe(true);
    expect(resolvedV2Dark('light', true)).toBe(false);
  });

  test('auto and an unset attribute follow the OS', () => {
    expect(resolvedV2Dark('auto', true)).toBe(true);
    expect(resolvedV2Dark(null, false)).toBe(false);
  });
});
