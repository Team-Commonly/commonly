import fs from 'fs';
import path from 'path';
import { V2_COLORS } from '../components/V2FeaturePage';

// TASK-681: V2FeaturePage's MUI theme cannot read var(), so its colours stay
// literal. This pins each literal to the light --v2-* token of the same role, so
// a token change fails here instead of drifting silently. Dark mode needs its own
// decision (UX Lead, TASK-681 ruling).
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
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  shadowSm: '',
  shadow: '',
  shadowLg: '',
};

// First declaration wins: the light block sits above any future dark scope.
const lightTokenValue = (name: string): string | null => {
  const m = new RegExp(`--v2-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  return m ? m[1].toLowerCase() : null;
};

describe('V2FeaturePage MUI palette matches the light --v2-* tokens', () => {
  const colourKeys = (Object.keys(TOKEN_FOR) as Array<keyof typeof V2_COLORS>)
    .filter((k) => TOKEN_FOR[k] !== '');

  test.each(colourKeys)('%s equals its light token', (key) => {
    expect(lightTokenValue(TOKEN_FOR[key])).not.toBeNull();
    expect(V2_COLORS[key].toLowerCase()).toBe(lightTokenValue(TOKEN_FOR[key]));
  });
});
