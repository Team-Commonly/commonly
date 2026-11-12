/**
 * F461. The socket a public Claude seat's headersHelper asks for the token.
 * It answers only a client that sends this turn's key first, its close never
 * waits on a client that stays connected, and a socket that can't be set up
 * falls back to the credential file with a warning.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { startHeaderCredentialChannel } from '../src/lib/adapters/claude.js';

const TOKEN = 'cm_agent_f461_channel_token';
let dir;
let channel;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hc-'));
  fs.chmodSync(dir, 0o700);
});
afterEach(async () => {
  await channel?.close();
  channel = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

// Connects, optionally sends `line`, and returns what the server sent before
// closing (or `null` if it never closed within the wait).
const ask = (socketPath, line, waitMs = 2000) => new Promise((resolve) => {
  let got = '';
  const socket = net.createConnection({ path: socketPath }, () => {
    if (line !== undefined) socket.write(line);
  });
  const timer = setTimeout(() => { socket.destroy(); resolve(null); }, waitMs);
  socket.on('data', (chunk) => { got += chunk; });
  socket.on('error', () => {});
  socket.on('close', () => { clearTimeout(timer); resolve(got); });
});

test('answers the token only to a client that sends this turn\'s key', async () => {
  channel = await startHeaderCredentialChannel(dir, TOKEN, { platform: 'darwin' });
  const key = fs.readFileSync(channel.keyPath, 'utf8').trim();
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(fs.statSync(channel.keyPath).mode & 0o777).toBe(0o600);
  expect(fs.statSync(channel.path).mode & 0o777).toBe(0o600);

  expect(await ask(channel.path, `${key}\n`)).toBe(TOKEN);
  // Someone who learned the path but not the key.
  expect(await ask(channel.path, '\n')).toBe('');
  expect(await ask(channel.path, `${'0'.repeat(64)}\n`)).toBe('');
  expect(await ask(channel.path, `${key.slice(0, 63)}\n`)).toBe('');
  expect(await ask(channel.path, 'x'.repeat(200))).toBe('');
  // A key split across writes still works.
  const split = await new Promise((resolve) => {
    let got = '';
    const socket = net.createConnection({ path: channel.path }, () => {
      socket.write(key.slice(0, 10));
      setTimeout(() => socket.write(`${key.slice(10)}\n`), 50);
    });
    socket.on('data', (chunk) => { got += chunk; });
    socket.on('close', () => resolve(got));
  });
  expect(split).toBe(TOKEN);
});

test('a client that connects and says nothing is dropped, and close() does not wait on it', async () => {
  channel = await startHeaderCredentialChannel(dir, TOKEN, { platform: 'darwin' });
  const lingering = net.createConnection({ path: channel.path });
  lingering.on('error', () => {});
  await new Promise((resolve) => { lingering.on('connect', resolve); });
  const started = Date.now();
  await channel.close();
  channel = null;
  expect(Date.now() - started).toBeLessThan(1000);
  expect(fs.existsSync(path.join(dir, 'headers.sock'))).toBe(false);
});

test('a socket that cannot be set up falls back to the file, with a warning', async () => {
  const warn = jest.fn();
  const missing = path.join(dir, 'gone');
  await expect(startHeaderCredentialChannel(missing, TOKEN, { platform: 'darwin', warn })).resolves.toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be set up .*keeps its credential file/));
  expect(String(warn.mock.calls[0][0])).not.toContain(TOKEN);
});

test('a path too long for a socket falls back to the file, with a warning', async () => {
  const warn = jest.fn();
  const deep = path.join(dir, 'x'.repeat(120));
  await expect(startHeaderCredentialChannel(deep, TOKEN, { platform: 'darwin', warn })).resolves.toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/too long/));
});

test('reverse: Windows and an empty token get no channel', async () => {
  await expect(startHeaderCredentialChannel(dir, TOKEN, { platform: 'win32' })).resolves.toBeNull();
  await expect(startHeaderCredentialChannel(dir, '  ', { platform: 'darwin' })).resolves.toBeNull();
  expect(fs.readdirSync(dir)).toEqual([]);
});
