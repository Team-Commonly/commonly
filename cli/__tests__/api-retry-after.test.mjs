// F637: a 429's Retry-After is kept on the thrown error, so the daemon can wait
// as long as the server asked instead of retrying in a second or two.
import {
  afterAll, describe, expect, jest, test,
} from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-api-retry-after-'));
await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => configTmpDir },
  homedir: () => configTmpDir,
}));

const { createClient, parseRetryAfterMs } = await import('../src/lib/api.js');

afterAll(() => fs.rmSync(configTmpDir, { recursive: true, force: true }));

const respond = (status, retryAfter) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
    text: async () => JSON.stringify({ message: 'rate limit exceeded' }),
  });
};

const failure = async () => {
  try {
    await createClient({ instance: 'https://api.example.test', token: 't' }).post('/api/machines/x/heartbeat');
  } catch (err) {
    return err;
  }
  throw new Error('expected the request to reject');
};

describe('Retry-After on a failed request', () => {
  test('in seconds', async () => {
    respond(429, '42');
    const err = await failure();
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(42_000);
    expect(err.message).toBe('rate limit exceeded');
  });

  test('as an HTTP date', async () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    respond(429, at);
    const err = await failure();
    expect(err.retryAfterMs).toBeGreaterThan(85_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(90_000);
  });

  test('absent or unreadable leaves it unset', async () => {
    respond(429, null);
    expect((await failure()).retryAfterMs).toBeUndefined();
    respond(429, 'soon');
    expect((await failure()).retryAfterMs).toBeUndefined();
  });

  test('the parser: seconds, a past date is zero, junk is undefined', () => {
    const now = Date.parse('2026-11-25T00:00:00Z');
    expect(parseRetryAfterMs('0', now)).toBe(0);
    expect(parseRetryAfterMs('60', now)).toBe(60_000);
    expect(parseRetryAfterMs('Wed, 25 Nov 2026 00:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfterMs('Tue, 24 Nov 2026 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('-5', now)).toBeUndefined();
    expect(parseRetryAfterMs('', now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
});
