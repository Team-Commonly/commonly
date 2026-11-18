/**
 * README frames (TASK-155, reshaped for D332). The README is the front door and
 * GitHub is its only renderer, so nothing here renders anything: jsdom has no
 * layout engine and GitHub's sanitizer decides what survives. What is pinned is
 * the shape every frame must keep (a centered block, 880 wide, alt text, an
 * italic caption under it) and the order of the page's top: one line, the
 * quick-start command, then the first GIF, all before the first section.
 *
 * Frames are PNG screenshots or GIF recordings in docs/assets/readme/. The 2x
 * rule is the one that cannot be seen by reading the README: the asset carries
 * at least two pixels per rendered pixel, which is what keeps an 880 wide frame
 * legible on a retina display. The file's own header is the instrument (a PNG's
 * IHDR, a GIF's logical screen descriptor), so no restated dimension is
 * compared against another restated dimension.
 *
 * The caption's `<sub>` is pinned for the same reason: GitHub strips `style`,
 * so a caption that keeps its shape but loses its tag silently returns to 16px
 * body text.
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const FRAME_DIR = 'docs/assets/readme/';
const HERO = 'docs/assets/readme/invite-and-mention.gif';
const QUICK_START = 'git clone https://github.com/Team-Commonly/commonly.git && cd commonly && ./install.sh';
const isFrameAsset = (name: string) => /\.(png|gif)$/.test(name);

/** Every <img> in the README, with its raw attributes. */
const images = [...README.matchAll(/<img\s+([^>]*?)\/>/g)].map((m) => {
  const attr = (name) => m[1].match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
  return { at: m.index, src: attr('src'), alt: attr('alt'), width: attr('width'), tag: m[0] };
});

const frames = images.filter((img) => img.src?.startsWith(FRAME_DIR));

/**
 * Characters of prose in an HTML fragment: anything outside a tag that is not
 * whitespace. Written as a scan rather than a tag-stripping regex — CodeQL's
 * js/incomplete-multi-character-sanitization reds the latter as a sanitizer,
 * and a strip that tolerates nested tags is the wrong instrument for a count.
 */
const proseLength = (html) => {
  let inTag = false;
  let count = 0;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag && !/\s/.test(ch)) count += 1;
  }
  return count;
};

/** Pixel width straight out of the file's own header: PNG IHDR, or a GIF's logical screen descriptor. */
const assetWidth = (file) => {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.png')) {
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
    return buf.readUInt32BE(16);
  }
  expect(buf.subarray(0, 6).toString('ascii')).toMatch(/^GIF8[79]a$/);
  return buf.readUInt16LE(6);
};

describe('README frames', () => {
  it('references at least the hero, and no asset in the frame directory goes unreferenced', () => {
    expect(frames.length).toBeGreaterThan(0);
    const onDisk = fs.readdirSync(path.join(REPO_ROOT, FRAME_DIR)).filter(isFrameAsset);
    expect(onDisk.length).toBe(frames.length);
    for (const name of onDisk) {
      expect(README).toContain(`${FRAME_DIR}${name}`);
    }
  });

  it.each(frames.map((f) => [f.src, f]))('%s exists, is centered and is captioned', (_src, frame) => {
    const file = path.join(REPO_ROOT, frame.src);
    expect(fs.existsSync(file)).toBe(true);

    // Centered: the frame sits inside an open align="center" container. A bare
    // <img> in an HTML block renders left-aligned on GitHub.
    const openAt = README.lastIndexOf('<div align="center">', frame.at);
    expect(openAt).toBeGreaterThanOrEqual(0);
    expect(README.slice(openAt, frame.at)).not.toContain('</div>');

    // Captioned: a <sub><em> under it, still inside that same block. <sub> is on
    // GitHub's supported formatting list and renders at 75%, which keeps a
    // caption on one line under an 880 wide frame (ux-lead, #1870).
    const closeAt = README.indexOf('</div>', frame.at);
    const emAt = README.indexOf('<sub><em>', frame.at);
    expect(closeAt).toBeGreaterThan(frame.at);
    expect(emAt).toBeGreaterThan(frame.at);
    expect(emAt).toBeLessThan(closeAt);
    // The caption must be THIS frame's: a <sub><em> found past the block's own
    // </div> belongs to a later frame, and would otherwise stand in for this one.
    expect(README.slice(frame.at, emAt)).not.toContain('</div>');
    expect(README.slice(emAt, closeAt)).toContain('</em></sub>');
    expect(proseLength(README.slice(emAt, closeAt))).toBeGreaterThan(20);

    // A frame is an image of something, so it needs real alt text.
    expect(frame.alt).not.toBeNull();
    expect(frame.alt.length).toBeGreaterThan(20);
    expect(frame.width).not.toBeNull();
  });

  it.each(frames.map((f) => [f.src, f]))('%s carries at least two pixels per rendered pixel', (_src, frame) => {
    const width = assetWidth(path.join(REPO_ROOT, frame.src));
    expect(Number(frame.width)).toBeGreaterThan(0);
    expect(width).toBeGreaterThanOrEqual(2 * Number(frame.width));
  });

  it('opens with the logo, then the quick-start command, then the hero, all before the first section', () => {
    const logoAt = README.indexOf('<img src="docs/assets/brand/commonly-mark-ink.svg"');
    const quickStartAt = README.indexOf(QUICK_START);
    const heroAt = README.indexOf(`<img src="${HERO}"`);
    const firstSectionAt = README.search(/^## /m);

    // Placement is an ORDER, so it is asserted as one. Every index is checked
    // for presence first: indexOf returns -1, and -1 < -1 compares equal.
    expect(logoAt).toBeGreaterThanOrEqual(0);
    expect(quickStartAt).toBeGreaterThan(0);
    expect(heroAt).toBeGreaterThan(0);
    expect(firstSectionAt).toBeGreaterThan(0);

    expect(frames[0].src).toBe(HERO);
    expect(quickStartAt).toBeGreaterThan(logoAt);
    expect(heroAt).toBeGreaterThan(quickStartAt);
    expect(heroAt).toBeLessThan(firstSectionAt);
  });

  it('links commonly.me above the hero', () => {
    const top = README.slice(0, README.indexOf(`<img src="${HERO}"`));
    expect(top).toContain('href="https://commonly.me"');
  });
});
