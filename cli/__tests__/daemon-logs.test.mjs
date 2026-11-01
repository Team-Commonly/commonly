import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonSeatLogPath, logSize, readAppended, readLogTail, tailLines } from '../src/lib/daemon-logs.js';

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

test('readAppended returns only bytes written after the offset, once', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-daemon-logs-'));
  const path = join(home, 'seat.log');
  writeFileSync(path, 'a\nb\n');
  const offset = logSize(path);
  appendFileSync(path, 'c\n');
  const first = readAppended(path, offset);
  expect(first.text).toBe('c\n');
  expect(readAppended(path, first.offset).text).toBe('');
});

test('readAppended reads from the start when the log was truncated', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-daemon-logs-'));
  const path = join(home, 'seat.log');
  writeFileSync(path, 'long previous content\n');
  const offset = logSize(path);
  writeFileSync(path, 'new\n');
  expect(readAppended(path, offset).text).toBe('new\n');
});
