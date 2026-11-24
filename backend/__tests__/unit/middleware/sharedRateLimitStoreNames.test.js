/**
 * Every SharedRateLimitStore counts under the Redis prefix `rl:<name>:`. Two
 * stores with the same name share one count, and a name that is another name
 * plus `:<more>` lands inside the other's key space. Either way one limiter
 * spends another's budget, silently, and only with Redis on (never in tests).
 *
 * So this scans the backend source for every construction and checks the
 * names. It also refuses a construction whose name is not a string literal,
 * since the scan could not see what name such a store gets.
 */
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '../../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);

const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) {
    return SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') ? [] : sourceFiles(full);
  }
  return /\.(ts|js)$/.test(entry.name) ? [full] : [];
});

const CONSTRUCTION = /new\s+SharedRateLimitStore\s*\(/g;
const LITERAL_NAME = /^new\s+SharedRateLimitStore\s*\(\s*\{\s*name:\s*'([^'\\]+)'\s*[,}]/;

const constructions = sourceFiles(BACKEND).flatMap((file) => {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(CONSTRUCTION)].map((match) => {
    const line = source.slice(0, match.index).split('\n').length;
    const name = LITERAL_NAME.exec(source.slice(match.index))?.[1] ?? null;
    return { at: `${path.relative(BACKEND, file)}:${line}`, name };
  });
});

describe('SharedRateLimitStore names', () => {
  test('the scan finds the stores (a broken scan would pass every check below)', () => {
    expect(constructions.length).toBeGreaterThan(30);
    expect(constructions.map((c) => c.at)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^routes\/auth\.ts:/)]),
    );
  });

  test('every construction names its store with a string literal', () => {
    const unnamed = constructions.filter((c) => c.name === null).map((c) => c.at);
    expect(unnamed).toEqual([]);
  });

  test('every name is unique', () => {
    const seen = new Map();
    const duplicates = [];
    constructions.forEach(({ at, name }) => {
      if (name === null) return;
      if (seen.has(name)) duplicates.push(`${name}: ${seen.get(name)} and ${at}`);
      else seen.set(name, at);
    });
    expect(duplicates).toEqual([]);
  });

  test('no name is another name followed by ":"', () => {
    const names = constructions.map((c) => c.name).filter((n) => n !== null);
    const overlaps = [];
    names.forEach((a) => names.forEach((b) => {
      if (a !== b && b.startsWith(`${a}:`)) overlaps.push(`rl:${a}: contains rl:${b}:`);
    }));
    expect(overlaps).toEqual([]);
  });
});
