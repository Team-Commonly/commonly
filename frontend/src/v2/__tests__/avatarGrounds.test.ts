import fs from 'fs';
import path from 'path';
import { characterAvatarFor, PICKER_ARCHETYPES, PICKER_CELL_COUNT } from '../utils/avatars';

// TASK-679: the character figure's ground is generated in TS, but the design
// tokens live in v2.css and design-system/tokens.css. These tests keep the
// three in step, so a token edit that skips the TS (or the reverse) fails here.

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

const tokensIn = (css: string, prefix: string): string[] => {
  const re = new RegExp(`--${prefix}-(?:agent|human)-\\d:\\s*(#[0-9a-fA-F]{6})`, 'g');
  return Array.from(css.matchAll(re), (m) => m[1].toLowerCase());
};

const groundSvg = (uri: string | null): string => decodeURIComponent(
  String(uri).replace(/^data:image\/svg\+xml;utf8,/, ''),
);

// The ground is the first layer renderFace paints (same read as avatarCharacter.test).
const groundOf = (uri: string | null): string => {
  const svg = decodeURIComponent(String(uri).replace(/^data:image\/svg\+xml;utf8,/, ''));
  const m = /<path d="[^"]*" fill="#([0-9a-fA-F]{6})"/.exec(svg);
  if (!m) throw new Error('no ground layer in avatar svg');
  return `#${m[1].toLowerCase()}`;
};

describe('character avatar grounds', () => {
  const v2Tokens = tokensIn(read('../v2.css'), 'v2-avatar');
  const designTokens = tokensIn(read('../../../design-system/tokens.css'), 'c-avatar');

  test('v2.css and design-system tokens list the same five grounds and the ring token', () => {
    expect(v2Tokens).toHaveLength(5);
    expect(designTokens).toEqual(v2Tokens);
  });

  test('every agent ground is one of the agent tokens, and no people ground is', () => {
    const agentTokens = v2Tokens.slice(0, 3);
    const humanTokens = v2Tokens.slice(3);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      const ground = groundOf(characterAvatarFor(`agent-${i}:bot`, 'agent') as string);
      seen.add(ground);
      expect(agentTokens).toContain(ground);
      expect(humanTokens).not.toContain(ground);
    }
    expect(seen.size).toBe(3);
  });

  test('every people ground is one of the human tokens, and no agent ground is', () => {
    const agentTokens = v2Tokens.slice(0, 3);
    const humanTokens = v2Tokens.slice(3);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      const ground = groundOf(characterAvatarFor(`user-${i}`, 'human') as string);
      seen.add(ground);
      expect(humanTokens).toContain(ground);
      expect(agentTokens).not.toContain(ground);
    }
    expect(seen.size).toBe(2);
  });

  // Lumen's HOLD on #3057: light skins lost their silhouette on the pale grounds.
  // A darker edge (skin x 0.78) now sits under light skins only (luminance >= 0.6).
  test('light skins get a darker edge; darker skins render without one', () => {
    const relativeLuminance = (hex: string): number => {
      const lin = [0, 2, 4].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    const edgeOf = (skin: string): string => skin
      .match(/../g)!
      .map((h) => Math.round(parseInt(h, 16) * 0.78).toString(16).padStart(2, '0'))
      .join('');

    expect(PICKER_CELL_COUNT).toBeGreaterThan(0);
    for (let i = 0; i < PICKER_CELL_COUNT; i += 1) {
      const skin = PICKER_ARCHETYPES[i].skin[0];
      const svg = groundSvg(characterAvatarFor(`edge-${i}-v${i + 1}`, 'human'));
      const light = relativeLuminance(skin) >= 0.6;
      expect(svg.includes(`fill="#${edgeOf(skin)}"`)).toBe(light);
    }
  });
});
