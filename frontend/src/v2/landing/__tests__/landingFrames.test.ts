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
