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
    expect(V2_DARK_COLORS[key].toLowerCase()).toBe(darkTokenValue(TOKEN_FOR[key]));
  });

  test('the dark block and its prefers-color-scheme twin agree', () => {
    // The twin paints when no attribute is set, so a drift between the two would
    // show dark on one path and not the other.
    colourKeys.forEach((key) => {
      expect(valueIn(darkTwinBlock, TOKEN_FOR[key])).toBe(valueIn(darkBlock, TOKEN_FOR[key]));
    });
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
