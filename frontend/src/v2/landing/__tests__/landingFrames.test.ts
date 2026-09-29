/**
 * The landing's four feature rows show the README's frames 2-5 (Activity, Your
 * team, Connectors, Bring your own agent), per docs/design/landing-demo/
 * Landing.dc.html. The frontend's build context is `frontend/` alone, so the
 * page cannot import from docs/ and carries copies. A copy drifts from its
 * source the moment either side is re-rendered, so each copy is pinned to its
 * README original byte for byte: re-render a frame and this fails until both
 * sides carry the new file.
 *
 * The page's imports are read from its source as well, because a byte check on
 * files the page no longer imports would pass on a landing that went back to
 * other screenshots.
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const LANDING_ASSETS = path.join(REPO_ROOT, 'frontend/src/assets/landing');
const README_FRAMES = path.join(REPO_ROOT, 'docs/assets/readme');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'V2LandingPage.tsx'), 'utf8');

const FRAMES: Array<[landing: string, readme: string]> = [
  ['activity.png', 'activity-2x.png'],
  ['team.png', 'team-2x.png'],
  ['connectors.png', 'connectors-2x.png'],
  ['byo.png', 'byo-2x.png'],
];

describe('landing feature frames', () => {
  test.each(FRAMES)('%s is byte-identical to the README frame %s', (landing, readme) => {
    const copy = fs.readFileSync(path.join(LANDING_ASSETS, landing));
    const source = fs.readFileSync(path.join(README_FRAMES, readme));
    expect(copy.equals(source)).toBe(true);
  });

  test('the page imports exactly these four frames, and no other landing image', () => {
    const imported = Array.from(PAGE.matchAll(/from '\.\.\/\.\.\/assets\/landing\/([^']+)'/g), (m) => m[1]).sort();
    expect(imported).toEqual(FRAMES.map(([landing]) => landing).sort());
  });

  test('no landing image is left behind that the page does not import', () => {
    const onDisk = fs.readdirSync(LANDING_ASSETS).filter((f) => f.endsWith('.png')).sort();
    expect(onDisk).toEqual(FRAMES.map(([landing]) => landing).sort());
  });
});

/**
 * TASK-205. The four frames are `loading="lazy"`, so before they load their box
 * is only as tall as its markup allows: with no width/height attributes that is
 * 0, the page grows 691px mid-scroll, and a first-click anchor on Use cases or
 * Pricing lands short — measured from the top of the page, frames unloaded.
 *
 * These assertions read the size out of each PNG's own IHDR and compare it with
 * what the page passes, so the page cannot disagree with the file it renders: a
 * re-shot frame at a new size fails here instead of silently restoring the
 * shift. They are source-derived rather than rendered deliberately — jest maps
 * every PNG import to the same file mock, so in a rendered tree all four <img>
 * elements carry one indistinguishable src and a render test could not say
 * which row got which numbers.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The frame's intrinsic size, from its IHDR chunk (signature, length, then "IHDR", width, height). */
const pngSize = (file: string): { width: number; height: number } => {
  const bytes = fs.readFileSync(path.join(LANDING_ASSETS, file));
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`${file} does not begin with an IHDR chunk, so a size read from it would be garbage`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

/** Import identifier -> landing asset filename, read from the page's own imports. */
const importedFrames = (): Map<string, string> => new Map(
  Array.from(PAGE.matchAll(/import\s+(\w+)\s+from '\.\.\/\.\.\/assets\/landing\/([^']+)'/g),
    (m) => [m[1], m[2]] as const),
);

const featureRows = (): Array<{ img: string; width: number; height: number }> => Array
  .from(PAGE.matchAll(/<FeatureRow\b[\s\S]*?\/>/g), (match) => {
    const img = /img=\{(\w+)\}/.exec(match[0]);
    const width = /width=\{(\d+)\}/.exec(match[0]);
    const height = /height=\{(\d+)\}/.exec(match[0]);
    if (!img || !width || !height) {
      throw new Error(`a FeatureRow passes no img/width/height: ${match[0].replace(/\s+/g, ' ')}`);
    }
    return { img: img[1], width: Number(width[1]), height: Number(height[1]) };
  });

describe('landing feature frames reserve their box (TASK-205)', () => {
  test('every feature row passes the size its own frame actually has', () => {
    const imports = importedFrames();
    const rows = featureRows();

    expect(rows).toHaveLength(FRAMES.length);
    for (const row of rows) {
      const file = imports.get(row.img);
      expect(file).toBeDefined();
      expect({ width: row.width, height: row.height }).toEqual(pngSize(file as string));
    }
  });

  test('FeatureRow puts that box on the img, and leaves the sizing lazy', () => {
    const element = /<img[\s\S]*?v2-landing__feature-img[\s\S]*?\/>/.exec(PAGE);
    expect(element).not.toBeNull();
    const tag = (element as RegExpExecArray)[0];

    // The props are only worth passing if the element they feed carries them.
    expect(tag).toContain('src={img}');
    expect(tag).toContain('width={width}');
    expect(tag).toContain('height={height}');
    expect(tag).toContain('loading="lazy"');
  });
});
