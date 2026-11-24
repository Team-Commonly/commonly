import fs from 'fs';
import path from 'path';

// A var(--v2-*) with no fallback whose token nothing defines computes to the
// property's initial value with no warning anywhere: a border-radius goes to 0
// and the card renders square. That shipped twice (the connector aside card,
// and a new inspector card caught in review), so every fallback-less use of a
// --v2- token in the frontend's CSS must name a token some stylesheet or an
// inline style defines.

const SRC = path.join(__dirname, '../..');

const filesUnder = (dir: string, ext: RegExp): string[] => (
  (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => ext.test(f) && !f.split(path.sep).includes('node_modules'))
    .map((f) => path.join(dir, f))
);

const cssFiles = filesUnder(SRC, /\.css$/);
const codeFiles = filesUnder(SRC, /\.(tsx?|jsx?)$/).filter((f) => !/\.test\./.test(f));

const defined = new Set<string>();
cssFiles.forEach((f) => {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/(--v2-[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
});
// Tokens a component sets inline, e.g. style={{ '--v2-x': value }} or setProperty('--v2-x', …).
codeFiles.forEach((f) => {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/['"](--v2-[a-zA-Z0-9-]+)['"]\s*[:,]/g)) defined.add(m[1]);
});

test('scans the real stylesheets', () => {
  expect(cssFiles.some((f) => f.endsWith(path.join('v2', 'v2.css')))).toBe(true);
  expect(defined.size).toBeGreaterThan(100);
});

test('every fallback-less var(--v2-*) names a defined token', () => {
  const undefinedUses: string[] = [];
  cssFiles.forEach((f) => {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/var\((--v2-[a-zA-Z0-9-]+)\s*\)/g)) {
        if (!defined.has(m[1])) undefinedUses.push(`${path.relative(SRC, f)}:${i + 1} ${m[1]}`);
      }
    });
  });
  expect(undefinedUses).toEqual([]);
});
