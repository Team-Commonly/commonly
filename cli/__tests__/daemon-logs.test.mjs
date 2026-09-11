import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonSeatLogPath, readLogTail, tailLines } from '../src/lib/daemon-logs.js';

test('tailLines returns the requested trailing lines', () => {
  expect(tailLines('one\ntwo\nthree\n', 2)).toBe('two\nthree');
  expect(tailLines('one\ntwo', 50)).toBe('one\ntwo');
});

test('readLogTail reports a missing log without throwing', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-daemon-logs-'));
  const path = join(home, 'daemon.log');
  expect(readLogTail(path)).toBeNull();
  writeFileSync(path, 'a\nb\nc\n');
  expect(readLogTail(path, 1)).toBe('c');
});

test('seat log names cannot escape the private log directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-daemon-logs-'));
  expect(daemonSeatLogPath('../secret', home)).toBe(`${home}/.commonly/logs/daemon/.._secret.log`);
});
