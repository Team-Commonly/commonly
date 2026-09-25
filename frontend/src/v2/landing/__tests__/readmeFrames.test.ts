/**
 * TASK-155. README frames are 2x captures of real surfaces, placed per
 * ux-lead's artboard (docs/design/landing-demo/Readme.dc.html): a centered
 * block, 880 wide, an italic caption under it. The README is the front door
 * and GitHub is its only renderer, so nothing here renders anything — jsdom
 * has no layout engine and GitHub's sanitizer decides what survives. What is
 * pinned is the shape a frame must keep, and it is pinned for EVERY frame the
 * README references rather than for the hero alone: frames 2-5 (Activity, Your
 * team, Connectors, Bring your own agent) land on this row later, and a frame
 * that is placed without its asset, at 1x, uncentered, uncaptioned, or with an
 * empty alt has to fail here rather than ship.
 *
 * The 2x rule is the one that cannot be seen by reading the README: the asset
 * carries at least two pixels per rendered pixel, which is what makes an 880
 * wide frame legible on a retina display. The PNG's own IHDR is the instrument
 * — no restated dimension is compared against another restated dimension.
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const FRAME_DIR = 'docs/assets/readme/';
const HERO = 'docs/assets/readme/demo-first-state-2x.png';

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

/** Width and height straight out of the PNG's IHDR chunk. */
const pngSize = (file) => {
  const buf = fs.readFileSync(file);
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

describe('README frames', () => {
  it('references at least the hero, and no asset in the frame directory goes unreferenced', () => {
    expect(frames.length).toBeGreaterThan(0);
    const onDisk = fs
      .readdirSync(path.join(REPO_ROOT, FRAME_DIR))
      .filter((name) => name.endsWith('.png'));
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

    // Captioned: an <em> under it, still inside that same block.
    const closeAt = README.indexOf('</div>', frame.at);
    const emAt = README.indexOf('<em>', frame.at);
    expect(closeAt).toBeGreaterThan(frame.at);
    expect(emAt).toBeGreaterThan(frame.at);
    expect(emAt).toBeLessThan(closeAt);
    expect(proseLength(README.slice(emAt, closeAt))).toBeGreaterThan(20);

    // A frame is an image of something, so it needs real alt text.
    expect(frame.alt).not.toBeNull();
    expect(frame.alt.length).toBeGreaterThan(20);
    expect(frame.width).not.toBeNull();
  });

  it.each(frames.map((f) => [f.src, f]))('%s carries at least two pixels per rendered pixel', (_src, frame) => {
    const { width } = pngSize(path.join(REPO_ROOT, frame.src));
    expect(Number(frame.width)).toBeGreaterThan(0);
    expect(width).toBeGreaterThanOrEqual(2 * Number(frame.width));
  });

  it('leads with the hero, after the header block and before "What is Commonly?"', () => {
    const logoAt = README.indexOf('<img src="frontend/src/assets/commonly-logo.png"');
    const heroAt = README.indexOf(`<img src="${HERO}"`);
    const headingAt = README.indexOf('## What is Commonly?');

    // Placement is an ORDER, so it is asserted as one. Every index is checked
    // for presence first: indexOf returns -1, and -1 < -1 compares equal.
    expect(logoAt).toBeGreaterThanOrEqual(0);
    expect(heroAt).toBeGreaterThanOrEqual(0);
    expect(headingAt).toBeGreaterThan(0);

    expect(frames[0].src).toBe(HERO);
    expect(heroAt).toBeGreaterThan(logoAt);
    expect(heroAt).toBeLessThan(headingAt);
  });

  it('links commonly.me from the hero caption', () => {
    const closeAt = README.indexOf('</div>', README.indexOf(`<img src="${HERO}"`));
    const caption = README.slice(README.indexOf('<em>', README.indexOf(`<img src="${HERO}"`)), closeAt);
    expect(caption).toContain('<a href="https://commonly.me">commonly.me</a>');
    expect(caption).toContain('pick an option on the card');
  });
});
