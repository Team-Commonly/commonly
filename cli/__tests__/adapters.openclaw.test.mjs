import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import openclaw, { TESTED_OPENCLAW_VERSIONS, parseOpenClawVersion } from '../src/lib/adapters/openclaw.js';
import { commonlyMcpServer } from '../src/lib/default-environment.js';
import { prepareCommitAttribution } from '../src/lib/commit-attribution.js';

// Captured with OpenClaw 2026.10.5 under fnm Node 24.16.0 on 2026-10-22.
// An isolated --config used a local OpenAI-compatible fake provider and an
// actual stdio MCP probe. The probe logged started/connected during agent exec.
const success = readFileSync(new URL('./fixtures/openclaw-exec-ok-2026.10.5.json', import.meta.url), 'utf8');
const overflow = readFileSync(new URL('./fixtures/openclaw-exec-overflow-2026.10.5.json', import.meta.url), 'utf8');

const childWith = (stdout, code = 0, signal = null) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = jest.fn();
  child.kill = jest.fn();
  queueMicrotask(() => {
    const bytes = Buffer.from(stdout);
    const split = Math.floor(bytes.length / 2);
    child.stdout.emit('data', bytes.subarray(0, split));
    child.stdout.emit('data', bytes.subarray(split));
    child.emit('close', code, signal);
  });
  return child;
};

let keyDir;
beforeEach(() => {
  keyDir = mkdtempSync(join(tmpdir(), 'pa2-key-'));
  writeFileSync(join(keyDir, 'key'), 'test-provider-key', { mode: 0o600 });
  chmodSync(join(keyDir, 'key'), 0o600);
});
afterEach(() => rmSync(keyDir, { recursive: true, force: true }));

const context = () => ({
  cwd: process.cwd(), agentName: 'pa2-test', instanceUrl: 'https://api.commonly.me',
  runtimeToken: 'cm_agent_test_runtime_token', _version: TESTED_OPENCLAW_VERSIONS[0],
  environment: {
    model: 'pong',
    provider: { id: 'probe', baseURL: 'http://127.0.0.1:1/v1', keyFile: join(keyDir, 'key') },
    mcp: [commonlyMcpServer()],
  },
});

test('version parser accepts the measured banner and rejects suffix or unknown builds', () => {
  expect(parseOpenClawVersion('OpenClaw 2026.10.5 (1b58cb9)')).toBe('2026.10.5');
  expect(parseOpenClawVersion('OpenClaw 2026.10.5+1.gabcdef0')).toBeNull();
  expect(parseOpenClawVersion('OpenClaw 2026.10.6')).toBe('2026.10.6');
  expect(parseOpenClawVersion('garbled')).toBeNull();
});

test('recorded exec envelope yields final and cost without exposing credentials in argv/config', async () => {
  let launched;
  const ctx = context();
  const result = await openclaw.spawn('hello', {
    ...ctx,
    _spawnImpl: (binary, args, options) => {
      const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
      launched = { binary, args, options, config };
      return childWith(success);
    },
  });
  expect(result).toEqual({ text: 'PONG', newSessionId: null, costUsd: 0 });
  expect(launched.args).toEqual(expect.arrayContaining(['agent', 'exec', '--json', '--message-file', '-']));
  expect(launched.args.join(' ')).not.toContain(ctx.runtimeToken);
  expect(launched.args.join(' ')).not.toContain('test-provider-key');
  expect(JSON.stringify(launched.config)).not.toContain(ctx.runtimeToken);
  expect(JSON.stringify(launched.config)).not.toContain('test-provider-key');
  expect(launched.config.mcp.servers.commonly.env.COMMONLY_TOKEN_FILE).toBeTruthy();
  expect(launched.options.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
  expect(launched.options.env.HOME).not.toBe(process.env.HOME);
});

test('the child retains the supplied Git attribution hook and both commit trailers', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'pa2-git-'));
  const git = (args, env = process.env) => execFileSync('git', args, {
    cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Fixture Author']);
  git(['config', 'user.email', 'fixture@example.test']);
  const attribution = prepareCommitAttribution({
    cwd: repo, agentName: 'pa2-test', displayName: 'PA2 Test', instanceId: 'local',
    adapter: 'openclaw', model: 'probe/pong', effort: 'default',
  });
  try {
    const ctx = context();
    await openclaw.spawn('commit', {
      ...ctx, cwd: repo, env: attribution.env, commitAttributionEnv: attribution.sandboxEnv,
      _spawnImpl: (_binary, _args, { env }) => {
        expect(git(['config', '--get', 'core.hooksPath'], env).trim()).toBe(attribution.hooksDirectory);
        writeFileSync(join(repo, 'change.txt'), 'seat change\n');
        git(['add', 'change.txt'], env);
        git(['commit', '-m', 'seat change'], env);
        return childWith(success);
      },
    });
    const message = git(['show', '-s', '--format=%B', 'HEAD']);
    expect(message).toContain('Co-authored-by: PA2 Test <');
    expect(message).toContain('Agent-Model: openclaw/probe/pong/default');
  } finally {
    attribution.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test.each(['public', 'internal'])('refuses %s trust before a model launch', async (trust) => {
  const ctx = context();
  ctx.environment.sandbox = { trust };
  const spawnImpl = jest.fn();
  await expect(openclaw.spawn('hello', { ...ctx, _spawnImpl: spawnImpl }))
    .rejects.toThrow(/public-trust seats are not supported/);
  expect(spawnImpl).not.toHaveBeenCalled();
});

test('refuses a sandbox declaration it cannot enforce before model launch', async () => {
  const ctx = context();
  ctx.environment.sandbox = { mode: 'workspace' };
  const spawnImpl = jest.fn();
  await expect(openclaw.spawn('hello', { ...ctx, _spawnImpl: spawnImpl }))
    .rejects.toThrow(/cannot be enforced/);
  expect(spawnImpl).not.toHaveBeenCalled();
});

test('strict pin refuses an untested version before model launch', async () => {
  const ctx = context();
  const spawnImpl = jest.fn();
  await expect(openclaw.spawn('hello', { ...ctx, _version: '2026.10.6', _spawnImpl: spawnImpl }))
    .rejects.toThrow(/not smoke-tested/);
  expect(spawnImpl).not.toHaveBeenCalled();
});

test.each([1, 2, 130, 143])('exit %i fails even with a successful envelope', async (code) => {
  const ctx = context();
  await expect(openclaw.spawn('hello', { ...ctx, _spawnImpl: () => childWith(success, code) }))
    .rejects.toThrow(/openclaw/i);
});

test('recorded context overflow envelope fails with its diagnostic', async () => {
  const ctx = context();
  await expect(openclaw.spawn('hello', { ...ctx, _spawnImpl: () => childWith(overflow, 1) }))
    .rejects.toThrow(/Context window exceeded/);
});

test('a locally timed-out child cannot turn a later exit zero into success', async () => {
  const ctx = context();
  let child;
  await expect(openclaw.spawn('hello', {
    ...ctx, timeoutMs: 5,
    _spawnImpl: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = jest.fn();
      child.kill = jest.fn();
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(success));
        child.emit('close', 0);
      }, 20);
      return child;
    },
  })).rejects.toThrow(/timed out/);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});
