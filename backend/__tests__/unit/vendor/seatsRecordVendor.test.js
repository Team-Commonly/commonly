/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
const fs = require('fs');
const path = require('path');
const { SOURCE, TARGET, FILES } = require('../../../scripts/sync-seats-record');

// One record format, two copies: the backend image cannot see packages/seats.
describe('vendored record-v1 writer', () => {
  it.each(FILES)('%s is byte-identical to packages/seats', (file) => {
    const vendored = fs.readFileSync(path.join(TARGET, file));
    const source = fs.readFileSync(path.join(SOURCE, file));
    expect(vendored.equals(source)).toBe(true);
  });

  it('copies every module the copied files import', () => {
    const missing = FILES.flatMap((file) => {
      const text = fs.readFileSync(path.join(SOURCE, file), 'utf8');
      const imports = [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)].map((m) => m[1]);
      return imports
        .map((spec) => path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)))
        .filter((target) => !FILES.includes(target));
    });
    expect(missing).toEqual([]);
  });

  it('carries no file the sync list does not name', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
    ));
    const present = walk(TARGET)
      .map((file) => path.relative(TARGET, file).split(path.sep).join('/'))
      .filter((file) => file !== 'README.md');
    expect(present.sort()).toEqual([...FILES].sort());
  });
});
