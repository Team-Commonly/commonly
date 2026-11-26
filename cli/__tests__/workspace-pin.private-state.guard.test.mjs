// F620: a workspace seat's pin lives in `workspace-pins` beside its state
// folder (workspacePinDir). A test state made straight in tmpdir therefore
// shares one tmpdir/workspace-pins with every other test and jest worker, and
// jest.teardown.cjs's rmdir of that shared folder can land between a mkdir and
// the staged write of another worker (ENOENT in CI). Every test state goes in
// its own mkdtemp parent: `path.join(mkdtemp(...), 'state')`, or a helper.
//
// This is a text check, so it is deliberately narrow: it flags a variable
// whose name mentions "state" (and does not end in Root, the private parent)
// assigned a bare mkdtemp straight under tmpdir.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const self = path.basename(fileURLToPath(import.meta.url));

const testFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full);
  return /\.(mjs|js)$/.test(entry.name) && entry.name !== self ? [full] : [];
});

const BARE_STATE = new RegExp(
  [
    '\\b(\\w*[sS]tate\\w*)\\s*=\\s*',
    '(?:fs\\.)?mkdtempSync\\(',
    '(?:path\\.)?join\\(',
    '(?:os\\.)?tmpdir\\(\\)',
    ',\\s*[\'"`][^\'"`]*[\'"`]\\s*\\)\\s*\\)',
  ].join(''),
  'g',
);

describe('test state folders keep their workspace pins private (F620)', () => {
  test('no test makes a state folder straight in tmpdir', () => {
    const offenders = [];
    for (const file of testFiles(here)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(BARE_STATE)) {
        if (/Root$/.test(match[1])) continue;
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(here, file)}:${line} ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the check sees the shape it guards against', () => {
    const bad = "const publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'x-state-'));";
    const good = "const publicState = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'x-state-')), 'state');";
    expect([...bad.matchAll(BARE_STATE)]).toHaveLength(1);
    expect([...good.matchAll(BARE_STATE)]).toHaveLength(0);
  });
});
