import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { reportRunStopped } from '../src/lib/run-stopped.js';

const okFetch = () => jest.fn(async () => ({ ok: true, status: 204 }));

describe('reportRunStopped (F551)', () => {
  test('posts the reason, name, platform and Node major to the env instance, with no key', async () => {
    const fetchImpl = okFetch();
    const sent = await reportRunStopped({
      agentName: 'cincono-codex',
      reason: 'no-token',
      env: { COMMONLY_API_URL: 'https://api.example.test/' },
      platform: 'win32',
      nodeVersion: 'v22.11.0',
      fetchImpl,
    });

    expect(sent).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/stats/run-stopped');
    expect(init.method).toBe('POST');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(init.body)).toEqual({
      reason: 'no-token', agentName: 'cincono-codex', platform: 'win32', nodeMajor: 22,
    });
  });

  test('with no URL in the env, it goes where a keyed run would: the saved or default instance', async () => {
    const fetchImpl = okFetch();
    await reportRunStopped({
      agentName: 'a1', reason: 'no-token', env: {}, fetchImpl, defaultUrl: () => 'https://api.commonly.me',
    });

    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.commonly.me/api/stats/run-stopped');
  });

  test.each([
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
    ['DO_NOT_TRACK=true', { DO_NOT_TRACK: 'true' }],
    ['COMMONLY_TELEMETRY=0', { COMMONLY_TELEMETRY: '0' }],
  ])('sends nothing under %s', async (_label, env) => {
    const fetchImpl = okFetch();
    const sent = await reportRunStopped({ agentName: 'a1', reason: 'no-token', env, fetchImpl });

    expect(sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a network failure or a hang never throws, and gives up at the timeout', async () => {
    const failing = jest.fn(async () => { throw new Error('ENOTFOUND'); });
    await expect(reportRunStopped({ agentName: 'a1', reason: 'no-token', env: {}, fetchImpl: failing })).resolves.toBe(false);

    const hanging = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const started = Date.now();
    await expect(reportRunStopped({
      agentName: 'a1', reason: 'no-token', env: {}, fetchImpl: hanging, timeoutMs: 50,
    })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('agent run reports before it exits on a missing key', () => {
    const source = readFileSync(new URL('../src/commands/agent.js', import.meta.url), 'utf8');
    const start = source.indexOf('// First run on this machine');
    const block = source.slice(start, source.indexOf('const instanceRefusal = named', start));

    const noKey = block.slice(block.indexOf('if (!record) {'));
    const exitAt = noKey.indexOf('process.exit(1)');

    const beforeExit = noKey.slice(0, exitAt);

    // The message prints first, so a dead network never leaves the screen blank.
    expect(beforeExit).toMatch(/await reportRunStopped\(\{ agentName: agentArg, reason: 'no-token' \}\)/);
    expect(beforeExit.indexOf('console.error(')).toBeLessThan(beforeExit.indexOf('reportRunStopped'));
  });
});
