/**
 * resolve-on-path.test.mjs — the first executable FILE on PATH (F146, from the
 * #3453 review). `accessSync(X_OK)` passes a directory, so a folder that shares
 * the binary's name, earlier on PATH, used to be returned as the binary.
 */
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { resolveOnPath } from '../src/lib/resolve-on-path.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'resolve-on-path-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const dir = (name) => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };
const executable = (d, name) => {
  const p = join(d, name);
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o755);
  return p;
};

test('a directory with the name, earlier on PATH, is passed over for the file after it', () => {
  const first = dir('first');
  mkdirSync(join(first, 'tool'), { mode: 0o755 });
  const second = dir('second');
  const real = executable(second, 'tool');

  expect(resolveOnPath('tool', [first, second].join(delimiter))).toBe(real);
});

test('a directory alone resolves to nothing', () => {
  const only = dir('only');
  mkdirSync(join(only, 'tool'), { mode: 0o755 });

  expect(resolveOnPath('tool', only)).toBeNull();
});

test('the first executable file wins', () => {
  const a = dir('a');
  const b = dir('b');
  const first = executable(a, 'tool');
  executable(b, 'tool');

  expect(resolveOnPath('tool', [a, b].join(delimiter))).toBe(first);
});

test('a file without the execute bit is passed over', () => {
  const a = dir('a');
  writeFileSync(join(a, 'tool'), 'not executable');
  chmodSync(join(a, 'tool'), 0o644);
  const b = dir('b');
  const real = executable(b, 'tool');

  expect(resolveOnPath('tool', [a, b].join(delimiter))).toBe(real);
});

// Deliberate, and unchanged: a relative or empty entry would resolve against
// the daemon's working directory, so it is skipped.
test('relative and empty entries are skipped, never resolved against the working directory', () => {
  const b = dir('b');
  const real = executable(b, 'tool');

  expect(resolveOnPath('tool', ['', 'relative/bin', b].join(delimiter))).toBe(real);
});
