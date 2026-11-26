/**
 * sandbox.guest-home.test.mjs: host file operations under a microVM seat HOME
 * never follow a link the guest left (sandbox/guest-home.js).
 *
 * Real symbolic links here; a Windows junction, which this Mac can't make, is
 * stood in for by an injected lstat that reports one (Node's lstat reports a
 * junction as a symbolic link), and the Windows smoke plants a real one.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  GUEST_PATH_REFUSED, ensureGuestDir, readGuestFile, removeGuestEntry, writeGuestFile,
} from '../src/lib/sandbox/guest-home.js';

let home;
let outside;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-home-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-outside-'));
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'host file');
});
afterEach(() => {
  for (const dir of [home, outside]) fs.rmSync(dir, { recursive: true, force: true });
});

const untouched = () => {
  expect(fs.readdirSync(outside)).toEqual(['victim.txt']);
  expect(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('host file');
};
const refused = (promise) => expect(promise).rejects.toMatchObject({ code: GUEST_PATH_REFUSED });

describe('ensureGuestDir', () => {
  test('makes missing folders one level at a time and returns the deepest', async () => {
    const dir = await ensureGuestDir(home, ['a', 'b', 'c']);
    expect(dir).toBe(path.join(home, 'a', 'b', 'c'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  test('refuses a link at any level, and makes nothing through it', async () => {
    fs.mkdirSync(path.join(home, 'a'));
    fs.symlinkSync(outside, path.join(home, 'a', 'b'), 'dir');
    await refused(ensureGuestDir(home, ['a', 'b', 'c']));
    untouched();
  });

  test('refuses the root itself when it is a link', async () => {
    const root = path.join(home, 'root');
    fs.symlinkSync(outside, root, 'dir');
    await refused(ensureGuestDir(root, ['x']));
    untouched();
  });

  test('refuses a file where a folder belongs', async () => {
    fs.writeFileSync(path.join(home, 'a'), '');
    await refused(ensureGuestDir(home, ['a']));
  });

  test('a junction, reported by lstat as a link, is refused (injected stat)', async () => {
    fs.mkdirSync(path.join(home, 'codex-home'));
    const junction = path.join(home, 'codex-home');
    const io = {
      ...fsp,
      lstat: async (p) => {
        const info = await fsp.lstat(p);
        return p === junction ? Object.assign(Object.create(info), { isSymbolicLink: () => true }) : info;
      },
    };
    await refused(ensureGuestDir(home, ['codex-home', 'tmp'], { io }));
    expect(fs.existsSync(path.join(home, 'codex-home', 'tmp'))).toBe(false);
  });

  test('a path part that is not a plain name is refused', async () => {
    await expect(ensureGuestDir(home, ['..'])).rejects.toThrow(/plain name/);
    await expect(ensureGuestDir(home, ['a/b'])).rejects.toThrow(/plain name/);
  });
});

describe('writeGuestFile', () => {
  test('writes through a random staged file and leaves nothing else', async () => {
    await writeGuestFile(home, 'AGENTS.md', 'one');
    await writeGuestFile(home, 'AGENTS.md', 'two');
    expect(fs.readdirSync(home)).toEqual(['AGENTS.md']);
    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).toBe('two');
  });

  test('refuses a link at the target', async () => {
    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(home, 'AGENTS.md'));
    await refused(writeGuestFile(home, 'AGENTS.md', 'planted'));
    untouched();
  });

  test('a write that fails after the stage is created leaves the target as it was and no stage behind', async () => {
    fs.writeFileSync(path.join(home, 'AGENTS.md'), 'before');
    let staged = null;
    const io = {
      lstat: fsp.lstat,
      rename: fsp.rename,
      unlink: fsp.unlink,
      open: async (file, flags, mode) => {
        staged = file;
        const handle = await fsp.open(file, flags, mode);
        return {
          writeFile: async () => { await handle.writeFile('par', 'utf8'); throw new Error('disk full'); },
          close: () => handle.close(),
        };
      },
    };
    await expect(writeGuestFile(home, 'AGENTS.md', 'after', { io })).rejects.toThrow('disk full');
    expect(path.dirname(staged)).toBe(home);
    expect(path.basename(staged)).toMatch(/^\.AGENTS\.md\.[0-9a-f]{24}\.tmp$/);
    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).toBe('before');
    expect(fs.readdirSync(home)).toEqual(['AGENTS.md']);
  });

  test('a link at the old guessable staged name is never written through', async () => {
    const guessed = path.join(home, `AGENTS.md.${process.pid}.tmp`);
    fs.symlinkSync(path.join(outside, 'victim.txt'), guessed);
    await writeGuestFile(home, 'AGENTS.md', 'fine');
    expect(fs.lstatSync(guessed).isSymbolicLink()).toBe(true);
    untouched();
  });
});

describe('removeGuestEntry', () => {
  test('removes a file, or a real folder and all it holds', async () => {
    fs.writeFileSync(path.join(home, 'f'), '');
    fs.mkdirSync(path.join(home, 'd', 'e'), { recursive: true });
    fs.writeFileSync(path.join(home, 'd', 'e', 'x'), '');
    expect(await removeGuestEntry(home, 'f')).toBe(true);
    expect(await removeGuestEntry(home, 'd')).toBe(true);
    expect(await removeGuestEntry(home, 'missing')).toBe(false);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  test('refuses a link at the entry, and leaves it and its target', async () => {
    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(home, 'AGENTS.override.md'));
    await refused(removeGuestEntry(home, 'AGENTS.override.md'));
    expect(fs.lstatSync(path.join(home, 'AGENTS.override.md')).isSymbolicLink()).toBe(true);
    untouched();
  });

  test('refuses a link inside a folder it would remove', async () => {
    fs.mkdirSync(path.join(home, 'skills'));
    fs.symlinkSync(outside, path.join(home, 'skills', 'inner'), 'dir');
    await refused(removeGuestEntry(home, 'skills'));
    expect(fs.lstatSync(path.join(home, 'skills', 'inner')).isSymbolicLink()).toBe(true);
    untouched();
  });
});

describe('readGuestFile', () => {
  test('reads at most the cap and says when it cut', async () => {
    fs.writeFileSync(path.join(home, 'r'), 'abcdef');
    expect(await readGuestFile(home, 'r', { maxBytes: 4 })).toEqual({ text: 'abcd', truncated: true });
    expect(await readGuestFile(home, 'r', { maxBytes: 6 })).toEqual({ text: 'abcdef', truncated: false });
    expect(await readGuestFile(home, 'missing', { maxBytes: 6 })).toBeNull();
  });

  test('refuses a link instead of reading through it', async () => {
    fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(home, 'r'));
    await refused(readGuestFile(home, 'r', { maxBytes: 100 }));
  });
});
