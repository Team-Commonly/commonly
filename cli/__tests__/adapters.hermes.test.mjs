/**
 * Fixtures are stdout captured from NousResearch/hermes-agent tag v0.22.2
 * (commit d923a5eb487a) on 2026-10-21. The real CLI was run twice with
 * --query-file - --format stream-json --provider openrouter --model test/model,
 * using an isolated HERMES_HOME and a local OpenAI-compatible test endpoint
 * answering PONG. The second capture passed --resume with the first session ID.
 * No provider credential or request body is stored in these fixtures.
 */
import { EventEmitter } from 'events';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { jest } from '@jest/globals';
import hermes, { TESTED_HERMES_VERSION, readHermesJsonl } from '../src/lib/adapters/hermes.js';

const fixture = async (name) => readFile(
  new URL(`./fixtures/hermes-0.22.2/${name}.jsonl`, import.meta.url), 'utf8',
);

const versionProbe = (version = TESTED_HERMES_VERSION) => jest.fn(() => ({
  status: 0, stdout: `Hermes Agent v${version} (local build)\n`,
}));

const recordedSpawn = (recording, onSpawn = () => {}, exitCode = 0) => (command, args, options) => {
  onSpawn(command, args, options);
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  queueMicrotask(() => {
    const middle = Math.floor(recording.length / 2);
    child.stdout.write(recording.slice(0, middle));
    child.stdout.end(recording.slice(middle));
    child.stderr.end();
    child.emit('close', exitCode);
  });
  return child;
};

const withHome = async (run) => {
  const home = await mkdtemp(join(tmpdir(), 'commonly-hermes-test-'));
  try { return await run(home); } finally { await rm(home, { recursive: true, force: true }); }
};

test('real 0.22.2 first and resumed JSONL return one final reply and a stable session', async () => {
  const first = await fixture('first-turn');
  const resumed = await fixture('resume');
  const firstEvents = first.trim().split('\n').map(JSON.parse);
  const resumeEvents = resumed.trim().split('\n').map(JSON.parse);
  expect(firstEvents.map((event) => event.type)).toEqual(['system', 'text', 'result']);
  expect(resumeEvents.map((event) => event.type)).toEqual(['system', 'text', 'result']);
  expect(resumeEvents[0].session_id).toBe(firstEvents[0].session_id);

  await withHome(async (home) => {
    const calls = [];
    const context = {
      cwd: home, agentName: 'pa1-test', env: { PATH: '/bin', OPENROUTER_API_KEY: 'fixture-only' },
      _hermesHome: join(home, 'profiles', 'pa1'), _spawnSyncImpl: versionProbe(),
    };
    const firstResult = await hermes.spawn('Reply PONG', {
      ...context, _spawnImpl: recordedSpawn(first, (...call) => calls.push(call)),
    });
    expect(firstResult).toEqual({ text: 'PONG', newSessionId: firstEvents[0].session_id });

    const resumeResult = await hermes.spawn('Reply again', {
      ...context, sessionId: firstResult.newSessionId,
      _spawnImpl: recordedSpawn(resumed, (...call) => calls.push(call)),
    });
    expect(resumeResult).toEqual({ text: 'PONG', newSessionId: firstResult.newSessionId });
    expect(calls).toHaveLength(2);
    for (const [command, args, options] of calls) {
      expect(command).toBe('hermes');
      expect(args).toEqual(expect.arrayContaining([
        'chat', '--oneshot', '--query-file', '-', '--format', 'stream-json',
        '--provider', 'openrouter', '--source', 'tool',
      ]));
      expect(args.join(' ')).not.toContain('fixture-only');
      expect(args.join(' ')).not.toContain('Reply');
      expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      expect(options.env.HERMES_HOME).toBe(join(home, 'profiles', 'pa1'));
    }
    expect(calls[1][1]).toEqual(expect.arrayContaining(['--resume', firstResult.newSessionId]));
    expect(calls[0][1]).not.toContain('--resume');
  });
});

test('refuses any Hermes version other than 0.22.2 before starting a turn', async () => {
  await withHome(async (home) => {
    const child = jest.fn();
    await expect(hermes.spawn('hello', {
      cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
      _spawnSyncImpl: versionProbe('0.22.3'), _spawnImpl: child,
    })).rejects.toThrow('Hermes 0.22.3 is unsupported; this adapter requires 0.22.2');
    expect(child).not.toHaveBeenCalled();
  });
});

test('refuses a public seat before probing or spawning Hermes', async () => {
  const probe = jest.fn();
  const child = jest.fn();
  await expect(hermes.spawn('hello', {
    environment: { sandbox: { trust: 'public' } },
    _spawnSyncImpl: probe, _spawnImpl: child,
  })).rejects.toThrow('no enforced confinement adapter exists');
  expect(probe).not.toHaveBeenCalled();
  expect(child).not.toHaveBeenCalled();
});

test('refuses a declared MCP server rather than silently dropping its tools', async () => {
  await expect(hermes.validateEnvironment({
    mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '@commonlyai/mcp'] }],
  })).rejects.toThrow('does not yet consume environment.mcp');
});

test('rejects invalid JSONL and a process that exits before its terminal result', async () => {
  const state = { started: false, result: null };
  readHermesJsonl('{"type":"system","subtype":"init","session_id":"s"}', state);
  expect(state.result).toBeNull();
  expect(() => readHermesJsonl('{bad', state)).toThrow('invalid JSONL');

  await withHome(async (home) => {
    const recording = (await fixture('first-turn')).split('\n')[0];
    await expect(hermes.spawn('hello', {
      cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
      _spawnSyncImpl: versionProbe(), _spawnImpl: recordedSpawn(`${recording}\n`),
    })).rejects.toThrow('without a complete JSONL result');
  });
});
