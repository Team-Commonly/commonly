/**
 * commonly_attach_file reads a local file and uploads it into a pod, so the
 * path it may read is confined: the working directory the server was started
 * in, plus any folder named in COMMONLY_ATTACH_ROOTS. Hidden files and folders
 * (any path part starting with ".") and key-shaped file names are refused
 * even inside those folders. Symlinks are resolved before the check.
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { jest } from '@jest/globals';
import { resolveAttachPath } from '../src/attach-path.js';
import { buildTools } from '../src/tools.js';

const tree = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'attach-path-')));
  const work = join(base, 'work');
  const outside = join(base, 'outside');
  const home = join(base, 'home');
  [work, outside, home, join(work, 'out'), join(work, '.git'), join(home, '.ssh')].forEach((d) => mkdirSync(d, { recursive: true }));
  writeFileSync(join(work, 'report.md'), 'r');
  writeFileSync(join(work, 'out', 'deck.pptx'), 'd');
  writeFileSync(join(work, '.env'), 'secret');
  writeFileSync(join(work, '.git', 'config'), 'c');
  writeFileSync(join(work, 'server.pem'), 'k');
  writeFileSync(join(work, 'id_ed25519'), 'k');
  writeFileSync(join(outside, 'notes.txt'), 'n');
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'k');
  writeFileSync(join(home, 'todo.txt'), 't');
  return { base, work, outside, home };
};

describe('resolveAttachPath', () => {
  test('a file under the working directory is allowed, by relative or absolute path', () => {
    const { work } = tree();
    const opts = { cwd: work, env: {}, home: '/nonexistent-home' };
    expect(resolveAttachPath('report.md', opts)).toBe(join(work, 'report.md'));
    expect(resolveAttachPath(join(work, 'out', 'deck.pptx'), opts)).toBe(join(work, 'out', 'deck.pptx'));
  });

  test('a file outside the working directory is refused, and the error says how to allow it', () => {
    const { work, outside } = tree();
    const opts = { cwd: work, env: {}, home: '/nonexistent-home' };
    expect(() => resolveAttachPath(join(outside, 'notes.txt'), opts)).toThrow(/COMMONLY_ATTACH_ROOTS/);
    expect(() => resolveAttachPath('../outside/notes.txt', opts)).toThrow(/outside/);
  });

  test('a folder named in COMMONLY_ATTACH_ROOTS is allowed too', () => {
    const { work, outside } = tree();
    const env = { COMMONLY_ATTACH_ROOTS: ['/nonexistent-root', outside].join(process.platform === 'win32' ? ';' : ':') };
    expect(resolveAttachPath(join(outside, 'notes.txt'), { cwd: work, env, home: '/nonexistent-home' }))
      .toBe(join(outside, 'notes.txt'));
  });

  test('hidden files and anything inside a hidden folder are refused, even under the working directory', () => {
    const { work } = tree();
    const opts = { cwd: work, env: {}, home: '/nonexistent-home' };
    expect(() => resolveAttachPath('.env', opts)).toThrow(/hidden/);
    expect(() => resolveAttachPath(join('.git', 'config'), opts)).toThrow(/hidden/);
  });

  test('key-shaped file names are refused', () => {
    const { work } = tree();
    const opts = { cwd: work, env: {}, home: '/nonexistent-home' };
    expect(() => resolveAttachPath('server.pem', opts)).toThrow(/key/);
    expect(() => resolveAttachPath('id_ed25519', opts)).toThrow(/key/);
  });

  test('a symlink inside the working directory that points outside it is refused', () => {
    const { work, outside, home } = tree();
    symlinkSync(join(outside, 'notes.txt'), join(work, 'notes-link.txt'));
    symlinkSync(join(home, '.ssh', 'id_rsa'), join(work, 'innocent.txt'));
    const opts = { cwd: work, env: {}, home: '/nonexistent-home' };
    expect(() => resolveAttachPath('notes-link.txt', opts)).toThrow(/outside/);
    expect(() => resolveAttachPath('innocent.txt', opts)).toThrow(/outside/);
  });

  test('a server started in the home folder (or /) gets no working-directory root', () => {
    const { home } = tree();
    expect(() => resolveAttachPath('todo.txt', { cwd: home, env: {}, home })).toThrow(/COMMONLY_ATTACH_ROOTS/);
    expect(() => resolveAttachPath(`${sep}etc${sep}hosts`, { cwd: sep, env: {}, home })).toThrow(/COMMONLY_ATTACH_ROOTS/);
    expect(resolveAttachPath('todo.txt', { cwd: home, env: { COMMONLY_ATTACH_ROOTS: home }, home })).toBe(join(home, 'todo.txt'));
    // An explicit root never re-opens the hidden rule.
    expect(() => resolveAttachPath(join('.ssh', 'id_rsa'), { cwd: home, env: { COMMONLY_ATTACH_ROOTS: home }, home })).toThrow(/hidden/);
  });

  test('a missing file says it is missing', () => {
    const { work } = tree();
    expect(() => resolveAttachPath('nope.txt', { cwd: work, env: {}, home: '/nonexistent-home' })).toThrow(/no file/i);
  });
});

describe('resolveAttachPath, review follow-ups', () => {
  test('outside the roots, a missing file and an existing one get the same answer', () => {
    const { work, outside } = tree();
    const opts = { cwd: work, env: {}, home: '/nonexistent-home' };
    const messageFor = (p) => { try { resolveAttachPath(p, opts); } catch (e) { return e.message.replace(p, '<p>'); } return null; };
    expect(messageFor(join(outside, 'notes.txt'))).toBe(messageFor(join(outside, 'missing.txt')));
  });

  test('a server started in a folder that holds the home folder gets no working-directory root', () => {
    const { base, home } = tree();
    writeFileSync(join(base, 'top.txt'), 't');
    expect(() => resolveAttachPath('top.txt', { cwd: base, env: {}, home })).toThrow(/COMMONLY_ATTACH_ROOTS/);
  });

  test('more key and credential file names are refused', () => {
    const { work } = tree();
    const opts = { cwd: work, env: {}, home: '/nonexistent-home' };
    for (const name of ['id_ed25519_sk', 'id_ecdsa_sk', 'putty.ppk', 'secret.gpg', 'key.asc', 'office.ovpn']) {
      writeFileSync(join(work, name), 'k');
      expect(() => resolveAttachPath(name, opts)).toThrow(/key/);
    }
  });

  test('a missing file in a symlinked working directory still says it is missing', () => {
    const { base, work } = tree();
    symlinkSync(work, join(base, 'work-link'));
    expect(() => resolveAttachPath('nope.txt', { cwd: join(base, 'work-link'), env: {}, home: '/nonexistent-home' })).toThrow(/no file/i);
  });

  test('a directory is refused with a clear message', () => {
    const { work } = tree();
    expect(() => resolveAttachPath('out', { cwd: work, env: {}, home: '/nonexistent-home' })).toThrow(/not a regular file/);
  });
});

describe('commonly_attach_file refuses before any request', () => {
  const okFetch = () => jest.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
  let saved;
  beforeEach(() => { saved = global.fetch; });
  afterEach(() => { global.fetch = saved; });

  test('a path outside the allowed folders is an error and nothing is sent', async () => {
    const fetchSpy = okFetch();
    global.fetch = fetchSpy;
    const { outside } = tree();
    const tools = Object.fromEntries(buildTools({ apiUrl: 'https://x.example', token: 't' }).map((t) => [t.name, t]));
    const result = await tools.commonly_attach_file.call({ podId: 'POD', filePath: join(outside, 'notes.txt') });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/COMMONLY_ATTACH_ROOTS/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the tool description names the rule', () => {
    const tools = Object.fromEntries(buildTools({ apiUrl: 'https://x.example', token: 't' }).map((t) => [t.name, t]));
    expect(tools.commonly_attach_file.description).toMatch(/working directory/);
    expect(tools.commonly_attach_file.description).toMatch(/COMMONLY_ATTACH_ROOTS/);
  });
});
