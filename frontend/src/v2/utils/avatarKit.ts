/**
 * Commonly's own avatar faces — the "Cut" direction, chosen by Sam on
 * 2026-09-23 over "Mark" and "Grid" on the Avatar kit canvas, replacing the
 * licensed DiceBear Big Smile style.
 *
 * Flat paper shapes on a 64-unit grid: shoulders, neck, head and ears, one of
 * seven hair cuts, eyes, a mouth, and optional glasses or a mustache. Paths and
 * fills only, so a face is about 1 KB, needs no library, fetches nothing, and
 * is safe under any CSP.
 *
 * Deterministic: the same seed and kind always give the same face. Species must
 * read at 20px, where art style alone does not: people wear light shirts and
 * agents wear ink with a cobalt collar, on top of the disjoint background
 * families the caller chooses. Agents also keep level eyes.
 */

export type FaceKind = 'human' | 'agent';
export type HairStyle = 'crop' | 'side' | 'bob' | 'bun' | 'long' | 'curly' | 'shaved';
export type Eyewear = 'none' | 'glasses' | 'sunglasses';
export type Mouth = 'smile' | 'bar' | 'small';
export type Accessory = 'glasses' | 'sunglasses' | 'mustache';

export interface FaceTraits {
  kind: FaceKind;
  /** Hex without '#', as every palette in this module. */
  background: string;
  skin: string;
  hair: string;
  style: HairStyle;
  eyewear: Eyewear;
  mustache: boolean;
  mouth: Mouth;
  shirt: string;
}

/** A curated picker cell: each field is the set the seed may pick from. */
export interface FaceCell {
  skin: readonly string[];
  hair: readonly HairStyle[];
  color: readonly string[];
  acc: readonly Accessory[];
}

// The full skin range, lightest to deepest. Every picker grid spans all eight.
export const SKIN_TONES = ['ffe4c0', 'f5d7b1', 'efcc9f', 'e2ba87', 'c99c62', 'a47539', '8c5a2b', '643d19'] as const;
// Natural browns and black plus two warm dyes; nothing that fights the tinted grounds.
export const HAIR_COLORS = ['220f00', '3a1a00', '71472d', 'd56c0c', 'e9b729'] as const;
export const HAIR_STYLES: readonly HairStyle[] = ['crop', 'side', 'bob', 'bun', 'long', 'curly', 'shaved'];
const MOUTHS: readonly Mouth[] = ['smile', 'bar', 'small'];
// Light only: a dark shirt is the agent cue, so no person may wear one.
const HUMAN_SHIRTS = ['f9fafb', 'e4e7ec', 'd0d5dd'] as const;
// Everyday eyewear for identity defaults, glasses twice as likely as sunglasses.
// A mustache only ever comes from a picker cell that offers it.
const DEFAULT_ACCESSORIES: readonly Accessory[] = ['glasses', 'glasses', 'sunglasses'];
const INK = '101828';
const COBALT = '1d3fd1';

const fnv1a = (input: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

/** mulberry32 seeded from the string: a stable stream of numbers in [0, 1). */
export const seededRandom = (seed: string): (() => number) => {
  let a = fnv1a(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * The traits for one face. The draw order below is part of the contract: it is
 * what makes a seed's face stable, so append new draws at the end, never
 * between existing ones.
 */
export const faceTraitsFor = (seed: string, kind: FaceKind, background: string, cell?: FaceCell): FaceTraits => {
  const next = seededRandom(`${seed}:${kind}`);
  const pick = <T>(options: readonly T[]): T => options[Math.floor(next() * options.length)];
  const skin = pick(cell ? cell.skin : SKIN_TONES);
  const hair = pick(cell ? cell.color : HAIR_COLORS);
  const style = pick(cell ? cell.hair : HAIR_STYLES);
  const accessoryRoll = next();
  const accessory = pick(cell && cell.acc.length ? cell.acc : DEFAULT_ACCESSORIES);
  const worn = accessoryRoll < (cell ? 0.2 : 0.25) ? accessory : null;
  const mouth = pick(MOUTHS);
  const shirt = pick(HUMAN_SHIRTS);
  return {
    kind,
    background,
    skin,
    hair,
    style,
    eyewear: worn === 'glasses' || worn === 'sunglasses' ? worn : 'none',
    mustache: worn === 'mustache',
    mouth,
    shirt: kind === 'agent' ? INK : shirt,
  };
};

// Two decimals keeps the markup short and identical across engines.
const n = (v: number): string => String(Math.round(v * 100) / 100);
const rect = (x: number, y: number, w: number, h: number) => `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}z`;
const rrect = (x: number, y: number, w: number, h: number, r: number) => (
  `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}v${n(h - 2 * r)}`
  + `a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)}h${n(-(w - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)}`
  + `v${n(-(h - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)}z`
);
// Every shape winds clockwise (sweep 1), so overlapping shapes in one path
// union instead of cutting holes under the nonzero fill rule.
const ellipse = (cx: number, cy: number, rx: number, ry: number) => (
  `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 1 ${n(2 * rx)} 0a${n(rx)} ${n(ry)} 0 1 1 ${n(-2 * rx)} 0z`
);
const circle = (cx: number, cy: number, r: number) => ellipse(cx, cy, r, r);

const darken = (hex: string, factor: number): string => {
  const v = parseInt(hex, 16);
  const ch = (shift: number) => Math.round(((v >> shift) & 255) * factor);
  return ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
};

const CROP = 'M18 27C18 15 25 11 32 11C40 11 46 15 46 26C41 20 36 18.5 31 19C26 19.5 21 22 18 27Z';
const FRINGE = 'M17 26C17 15 24 11 32 11C40 11 47 15 47 26C43 21 37 20 32 20C27 20 21 21 17 26Z';
const HAIR_FRONT: Record<HairStyle, string> = {
  crop: CROP,
  side: 'M18 29C17 15 25 11 33 11C41 11 47 16 46 27C40 23 32 21 26 17C24 21 21 25 18 29Z',
  bob: FRINGE,
  bun: circle(32, 9, 6.5) + CROP,
  long: FRINGE,
  curly: circle(19, 21, 5.5) + circle(23, 14.5, 6) + circle(31, 11.5, 6.5) + circle(39.5, 13.5, 6) + circle(45, 20, 5.5),
  shaved: 'M19 22C21 15 26 13 32 13C38 13 43 15 45 22C40 18.5 36 18 32 18C28 18 24 18.5 19 22Z',
};
const HAIR_BACK: Partial<Record<HairStyle, string>> = {
  bob: 'M14 31C14 15 22 9 32 9C42 9 50 15 50 31V46H41V26H23V46H14Z',
  long: rrect(13, 12, 38, 52, 15),
};
const MOUTH: Record<Mouth, string> = {
  smile: 'M28 37.5Q32 42 36 37.5Q32 39.5 28 37.5Z',
  bar: rrect(29, 38, 6, 2, 1),
  small: ellipse(32, 38.5, 1.8, 1.4),
};
const SHOULDERS = 'M8 64C8 51 18 46 32 46C46 46 56 51 56 64Z';
const COLLAR = 'M25 47.2L32 55L39 47.2C36.8 46.6 34.5 46.3 32 46.3C29.5 46.3 27.2 46.6 25 47.2Z';
const MUSTACHE = 'M26.5 35.6C28.5 34.2 30.8 34.4 32 35.4C33.2 34.4 35.5 34.2 37.5 35.6C35.6 37.2 33.4 37 32 36.2C30.6 37 28.4 37.2 26.5 35.6Z';

/** The face as a standalone SVG string, drawn back to front. */
export const renderFace = (t: FaceTraits): string => {
  const agent = t.kind === 'agent';
  const layers: Array<[string, string]> = [[rect(0, 0, 64, 64), t.background]];
  const back = HAIR_BACK[t.style];
  if (back) layers.push([back, t.hair]);
  layers.push([SHOULDERS, t.shirt]);
  layers.push([rect(27, 38, 10, 10) + ellipse(32, 29, 14, 16) + circle(18.5, 31, 3.6) + circle(45.5, 31, 3.6), t.skin]);
  layers.push([circle(24, 36, 2.6) + circle(40, 36, 2.6), darken(t.skin, 0.9)]);
  layers.push([HAIR_FRONT[t.style], t.hair]);
  if (t.mustache) layers.push([MUSTACHE, t.hair]);
  if (t.eyewear !== 'none') layers.push([circle(26, 30, 5.5) + circle(38, 30, 5.5) + rect(31, 29, 2, 1.6), INK]);
  if (t.eyewear === 'glasses') layers.push([circle(26, 30, 4.1) + circle(38, 30, 4.1), t.skin]);
  const eyes = agent
    ? rrect(22.5, 29.5, 7, 2.4, 1.2) + rrect(34.5, 29.5, 7, 2.4, 1.2)
    : ellipse(26, 30.5, 1.9, 2.5) + ellipse(38, 30.5, 1.9, 2.5);
  layers.push([(t.eyewear === 'sunglasses' ? '' : eyes) + MOUTH[t.mouth], INK]);
  if (agent) layers.push([COLLAR, COBALT]);
  const paths = layers.map(([d, fill]) => `<path d="${d}" fill="#${fill}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${paths}</svg>`;
};

export const faceDataUri = (svg: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
