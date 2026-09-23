import { characterAvatarFor, PICKER_ARCHETYPES, PICKER_CELL_COUNT } from '../utils/avatars';
import {
  faceTraitsFor, renderFace, HAIR_STYLES, SKIN_TONES, FaceTraits,
} from '../utils/avatarKit';

const svgOf = (uri: string | null): string => decodeURIComponent(String(uri).replace(/^data:image\/svg\+xml;utf8,/, ''));

/**
 * The character tier: Commonly's own faces for BOTH species (the "Cut" kit,
 * Sam 2026-09-23, replacing Big Smile), with species carried by disjoint
 * background families and by dress: agents in ink with a cobalt collar. Everything here defends
 * the properties that make it shippable at all — determinism, distinctness,
 * species legibility, and a fallback that cannot strand a render.
 */
describe('characterAvatarFor', () => {
  test('is deterministic — same identity, same face, forever', () => {
    expect(characterAvatarFor('scout:default', 'agent'))
      .toBe(characterAvatarFor('scout:default', 'agent'));
    expect(characterAvatarFor('user-123', 'human'))
      .toBe(characterAvatarFor('user-123', 'human'));
  });

  test('same seed still renders differently across kinds', () => {
    // The species signal moved from art style to background family, but the
    // rule is unchanged: a human and an agent must never be confusable by
    // avatar even if their seeds collide. Disjoint palettes guarantee it.
    const agent = characterAvatarFor('same-seed', 'agent');
    const human = characterAvatarFor('same-seed', 'human');
    expect(agent).not.toBeNull();
    expect(human).not.toBeNull();
    expect(agent).not.toBe(human);
  });

  test('distinct agents get distinct characters across the real roster', () => {
    const roster = [
      'fable-lead:default', 'sprint-review:default', 'pod-architect:default',
      'sprint-impl:default', 'ux-lead:default', 'scout:default',
      'scout:u0da521ab41', 'scout:ucc4035c51b',
    ];
    const seen = new Set(roster.map((s) => characterAvatarFor(s, 'agent')));
    expect(seen.size).toBe(roster.length);
  });

  test('an empty seed yields null so the caller falls back to initials', () => {
    expect(characterAvatarFor('', 'agent')).toBeNull();
    expect(characterAvatarFor(null, 'human')).toBeNull();
    expect(characterAvatarFor(undefined, 'agent')).toBeNull();
  });

  test('output is a self-contained data URI, never a network fetch', () => {
    // The whole point over generated art: local, deterministic, CSP-safe.
    const uri = characterAvatarFor('scout:default', 'agent');
    expect(uri).toMatch(/^data:image\/svg\+xml/);
  });

  test('every archetype cell renders its own skin tone, every user', () => {
    // Sam's rule (2026-08-21): explicit representation, not a rolled
    // gradient. Each of the 24 cells is a curated combination; the cell's
    // tone must appear in the RENDERED SVG itself, so a table edit that stops
    // reaching the renderer fails loudly instead of silently rolling faces.
    expect(PICKER_ARCHETYPES).toHaveLength(24);
    for (const base of ['sam', 'someone-else']) {
      PICKER_ARCHETYPES.forEach((cell, i) => {
        const uri = characterAvatarFor(`${base}-v${i + 1}`, 'human');
        expect(uri).not.toBeNull();
        const svg = decodeURIComponent(String(uri));
        expect(cell.skin.some((tone) => svg.includes(tone))).toBe(true);
      });
    }
  });

  test('the archetype table stays representation-complete', () => {
    // The four ethnic rows and both gender presentations must survive edits:
    // all 8 skin tones appear somewhere, and both accessory shapes
    // (mustache-bearing male-leaning, mustache-free female-leaning) exist.
    expect(PICKER_CELL_COUNT).toBe(PICKER_ARCHETYPES.length);
    const tones = new Set(PICKER_ARCHETYPES.flatMap((c) => c.skin));
    for (const tone of SKIN_TONES) {
      expect(tones.has(tone)).toBe(true);
    }
    expect(PICKER_ARCHETYPES.some((c) => c.acc.includes('mustache'))).toBe(true);
    expect(PICKER_ARCHETYPES.some((c) => !c.acc.includes('mustache'))).toBe(true);
  });

  test('non-picker seeds (identity defaults) still render without pinned traits', () => {
    // The -v suffix is the picker contract; a bare identity seed must not
    // accidentally match it.
    expect(characterAvatarFor('fable-lead:default', 'agent')).not.toBeNull();
    expect(characterAvatarFor('user-v9000', 'human')).not.toBeNull();
  });

  test('species reads from the face itself: agents in ink with a cobalt collar', () => {
    // At 20px the ground colour alone is not enough; the shirt carries it too.
    const shirtOf = (svg: string) => /<path d="M8 64C[^"]*" fill="#([0-9a-f]{6})"/.exec(svg)?.[1];
    for (const seed of ['scout:default', 'fable-lead:default', 'wren:default']) {
      const agent = svgOf(characterAvatarFor(seed, 'agent'));
      expect(shirtOf(agent)).toBe('101828');
      expect(agent).toContain('fill="#1d3fd1"');
    }
    for (const seed of ['user-123', 'sam', 'someone-else', 'sam-v4', 'sam-v23']) {
      const human = svgOf(characterAvatarFor(seed, 'human'));
      expect(['f9fafb', 'e4e7ec', 'd0d5dd']).toContain(shirtOf(human));
      expect(human).not.toContain('fill="#1d3fd1"');
    }
  });

  test('a face is small, self-contained SVG that parses', () => {
    const roster = ['scout:default', 'user-123', 'sam-v7', 'sam-v22', 'fable-lead:default'];
    for (const seed of roster) {
      for (const kind of ['human', 'agent'] as const) {
        const svg = svgOf(characterAvatarFor(seed, kind));
        expect(svg.length).toBeLessThan(2048);
        // The namespace declaration is the one URI an SVG must carry; nothing
        // else may point outside the face.
        expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:|href=|<image|<style|<script|foreignObject/);
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
        expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 64 64');
      }
    }
  });

  test('every arc winds clockwise, so overlapping shapes union instead of cutting holes', () => {
    // Head, neck and ears share one path. Under the nonzero fill rule an arc
    // wound the other way cancels where it overlaps a clockwise rect, which
    // once punched a ground-coloured hole under every chin on the canvas.
    for (const style of HAIR_STYLES) {
      const svg = renderFace({
        kind: 'agent', background: '0e7490', skin: 'efcc9f', hair: '220f00', style,
        eyewear: 'glasses', mustache: true, mouth: 'small', shirt: '101828',
      });
      expect(svg).toMatch(/ 0 1 1 /);
      expect(svg).not.toMatch(/a[\d.]+ [\d.]+ 0 [01] 0 /);
    }
  });

  test('every hair cut, eyewear and the mustache draw something distinct', () => {
    const base: FaceTraits = {
      kind: 'human', background: '2f6feb', skin: 'efcc9f', hair: '220f00', style: 'crop',
      eyewear: 'none', mustache: false, mouth: 'smile', shirt: 'f9fafb',
    };
    const cuts = new Set(HAIR_STYLES.map((style) => renderFace({ ...base, style })));
    expect(cuts.size).toBe(HAIR_STYLES.length);
    const variants = new Set([
      renderFace(base),
      renderFace({ ...base, eyewear: 'glasses' }),
      renderFace({ ...base, eyewear: 'sunglasses' }),
      renderFace({ ...base, mustache: true }),
    ]);
    expect(variants.size).toBe(4);
  });

  test('the traits draw is stable, and picker cells stay inside their cell', () => {
    // The draw order is the contract that keeps a seed's face stable; if this
    // changes, every stored pick redraws.
    expect(faceTraitsFor('sam', 'human', '2f6feb')).toEqual(faceTraitsFor('sam', 'human', '2f6feb'));
    PICKER_ARCHETYPES.forEach((cell, i) => {
      const t = faceTraitsFor(`sam-v${i + 1}`, 'human', '2f6feb', cell);
      expect(cell.skin).toContain(t.skin);
      expect(cell.hair).toContain(t.style);
      expect(cell.color).toContain(t.hair);
      if (t.mustache) expect(cell.acc).toContain('mustache');
    });
  });
});
