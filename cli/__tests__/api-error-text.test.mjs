import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-api-error-text-'));
await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => configTmpDir },
  homedir: () => configTmpDir,
}));

const { saveInstance } = await import('../src/lib/config.js');
const { createClient } = await import('../src/lib/api.js');
const { classifySpawnFailure, SPAWN_FAILURE_CLASS } = await import('../src/lib/spawn-retry.js');

afterAll(() => fs.rmSync(path.join(configTmpDir, '.commonly'), { recursive: true, force: true }));

beforeEach(() => {
  saveInstance({
    key: 'dev', url: 'https://api.commonly.me', token: 't', userId: 'u1', username: 'lily',
  });
});

const respond = (status, text) => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status, text: async () => text });
};

const failure = async () => {
  try {
    await createClient({ instance: 'dev' }).get('/api/agents/runtime/events');
  } catch (err) {
    return err;
  }
  throw new Error('expected the request to reject');
};

// The shape of the page Cloudflare serves when the tunnel cannot reach the origin.
const tunnelPage = [
  '<!DOCTYPE html>',
  '<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->',
  '<html class="no-js" lang="en-US">',
  '    <head>',
  '        <title>Cloudflare Tunnel error | api.commonly.me | Cloudflare</title>',
  '    </head>',
  '    <body>',
  ...Array.from({ length: 100 }, (_, i) => `        <div class="row-${i}">Cloudflare Tunnel error</div>`),
  '    </body>',
  '</html>',
].join('\n');

test('an HTML error page becomes one line named by its <title>', async () => {
  respond(502, tunnelPage);
  const err = await failure();
  expect(err.message).toBe('HTTP 502: Cloudflare Tunnel error | api.commonly.me | Cloudflare');
  expect(err.message).not.toContain('\n');
  expect(err.status).toBe(502);
  // Callers that classify the failure still see the whole page.
  expect(err.body.message).toBe(tunnelPage);
});

test('a classifiable word only in the discarded page body still classifies', async () => {
  // 502, so the status === 429 shortcut cannot fire: the words exist only in
  // err.body.message, which the one-line message drops (Vera, #2092 review).
  const page = [
    '<!DOCTYPE html><html><head><title>Bad gateway</title></head><body>',
    ...Array.from({ length: 80 }, (_, i) => `<div class="row-${i}">upstream</div>`),
    '<p>rate limit exceeded</p>',
    '</body></html>',
  ].join('\n');
  respond(502, page);
  const err = await failure();
  expect(err.message).toBe('HTTP 502: Bad gateway');
  expect(err.message).not.toMatch(/rate limit/);
  expect(classifySpawnFailure(err)).toBe(SPAWN_FAILURE_CLASS.RATE_LIMIT);
});

test('an HTML page with no <title> is named by its status', async () => {
  respond(503, '<html><body><h1>Service Unavailable</h1></body></html>');
  expect((await failure()).message).toBe('HTTP 503 (HTML error page)');
});

test('a short plain-text error is kept verbatim', async () => {
  respond(429, 'Too many requests, please try again later.');
  const err = await failure();
  expect(err.message).toBe('Too many requests, please try again later.');
  expect(classifySpawnFailure(err)).toBe(SPAWN_FAILURE_CLASS.RATE_LIMIT);
});

test('a long plain-text error is collapsed to one line and capped', async () => {
  const text = `upstream failed\n${'x'.repeat(1000)}`;
  respond(500, text);
  const err = await failure();
  expect(err.message).not.toContain('\n');
  expect(err.message).toHaveLength(301);
  expect(err.message.endsWith('…')).toBe(true);
  expect(err.body.message).toBe(text);
});

test('an empty body falls back to the status', async () => {
  respond(500, '');
  expect((await failure()).message).toBe('HTTP 500');
});

test('a JSON error body is unchanged', async () => {
  respond(403, JSON.stringify({ error: 'grant_not_found', code: 'grant_not_found' }));
  const err = await failure();
  expect(err.message).toBe('grant_not_found');
  expect(err.body.code).toBe('grant_not_found');
});
