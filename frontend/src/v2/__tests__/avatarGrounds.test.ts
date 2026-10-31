import fs from 'fs';
import path from 'path';
import {
  characterAvatarFor, paperAvatarFor, PICKER_ARCHETYPES, PICKER_CELL_COUNT,
} from '../utils/avatars';

// TASK-679: the character figure's ground is generated in TS, but the design
// tokens live in v2.css and design-system/tokens.css. These tests keep the
// three in step, so a token edit that skips the TS (or the reverse) fails here.

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

const tokensIn = (css: string, prefix: string): string[] => {
  const re = new RegExp(`--${prefix}-(?:agent|human)-\\d:\\s*(#[0-9a-fA-F]{6})`, 'g');
  return Array.from(css.matchAll(re), (m) => m[1].toLowerCase());
};

// The ring token pair (--<prefix>-frame and -frame-dark), read as written.
const ringIn = (css: string, prefix: string): { frame: string; dark: string } => {
  const valueOf = (name: string): string => {
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
    return m ? m[1].trim() : '';
  };
  return {
    frame: valueOf(`${prefix}-frame`),
    dark: valueOf(`${prefix}-frame-dark`),
  };
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
  const v2Css = read('../v2.css');
  const designCss = read('../../../design-system/tokens.css');

  test('v2.css and design-system tokens list the same seven grounds and ring values', () => {
    expect(v2Tokens).toHaveLength(7);
    expect(designTokens).toEqual(v2Tokens);
    // A ring edit in one file and not the other fails here, not in the screenshot.
    expect(ringIn(designCss, 'c-avatar')).toEqual(ringIn(v2Css, 'v2-avatar'));
    expect(ringIn(v2Css, 'v2-avatar').frame).not.toBe('');
    expect(ringIn(v2Css, 'v2-avatar').dark).not.toBe('');
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
    expect(seen.size).toBe(4);
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

  // TASK-683: Paper (unpicked people) sits on the same four people grounds as the
  // Cut tier, so the picker and the defaults match the artboard's warm set.
  test('Paper tiles draw only from the people grounds', () => {
    const humanTokens = v2Tokens.slice(3);
    const grounds = new Set<string>();
    for (let i = 0; i < 240; i += 1) {
      grounds.add(groundOf(paperAvatarFor(`paper-user-${i}`)));
    }
    expect(grounds.size).toBe(4);
    grounds.forEach((g) => expect(humanTokens).toContain(g));
  });

  // The 24 Paper looks (4 grounds x 3 necklines x 2 shirts) must each be distinct
  // and spread six to a ground, so no warm ground repeats a look.
  test('the 24 Paper looks are distinct, six on each of the four warm grounds', () => {
    const looksByGround = new Map<string, Set<string>>();
    for (let i = 0; i < 240; i += 1) {
      const uri = String(paperAvatarFor(`paper-look-${i}`));
      const ground = groundOf(uri);
      if (!looksByGround.has(ground)) looksByGround.set(ground, new Set());
      looksByGround.get(ground)!.add(uri);
    }
    expect(looksByGround.size).toBe(4);
    const all = new Set<string>();
    looksByGround.forEach((looks) => looks.forEach((l) => all.add(l)));
    expect(all.size).toBe(24);
    looksByGround.forEach((looks) => expect(looks.size).toBe(6));
  });

  // Lumen's HOLD on 63722f8e: the Paper figure washed out on the warm grounds
  // (1.01 to 1.22:1). Paper paints, in order: ground, shirt, head rect, head
  // ellipse, then an optional neckline cutout. Each part is checked against what
  // it sits on: head against the ground, shirt against the ground, and the
  // neckline against the shirt (Sable 5722118100: the neckline must show on both shirts).
  test('every Paper part clears 2:1 against what it sits on, necklines included', () => {
    const luminance = (hex: string): number => {
      const lin = [0, 2, 4].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    const ratio = (a: string, b: string): number => {
      const x = luminance(a);
      const y = luminance(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    for (let i = 0; i < 240; i += 1) {
      const uri = String(paperAvatarFor(`paper-contrast-${i}`));
      const ground = groundOf(uri);
      const [bg, shirt, headRect, headEllipse, neckline] = Array.from(
        groundSvg(uri).matchAll(/fill="#([0-9a-fA-F]{6})"/g),
        (m) => m[1].toLowerCase(),
      );
      expect(bg).toBe(ground.slice(1));
      expect(ratio(shirt, bg)).toBeGreaterThanOrEqual(2);
      expect(ratio(headRect, bg)).toBeGreaterThanOrEqual(2);
      expect(ratio(headEllipse, bg)).toBeGreaterThanOrEqual(2);
      if (neckline !== undefined) expect(ratio(neckline, shirt)).toBeGreaterThanOrEqual(2);
    }
  });
});
