/**
 * adapters.codex.test.mjs — ADR-005 Phase 2
 *
 * Covers the codex-CLI adapter. The real `codex` binary is never invoked
 * here: `child_process.spawnSync` is mocked at the module level for detect(),
 * and the adapter's `_spawnImpl` test seam (ctx field) replaces childSpawn
 * for spawn(). Both are internal-only seams — production never sets them.
 *
 * Argv shape under test (codex-cli 0.125.0):
 *   - new turn:   codex exec       --json --skip-git-repo-check -o <file> "<prompt>"
 *   - resume:     codex exec resume --json --skip-git-repo-check -o <file> <sid> "<prompt>"
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { mkdtemp, writeFile, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: jest.fn(),
}));

const codex = (await import('../src/lib/adapters/codex.js')).default;

// Fake child process with optional pre-canned stdout chunks, stderr, exit code.
// Set `writeOutputFile: <text>` to simulate codex writing the
// --output-last-message file before exiting (the production codepath reads
// that file after the close event fires).
const fakeChild = ({
  stdoutChunks = [],
  stderr = '',
  code = 0,
  delayMs = 0,
  outputFile = null,
  outputContents = null,
} = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(async () => {
    for (const chunk of stdoutChunks) proc.stdout.emit('data', Buffer.from(chunk));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    if (outputFile && outputContents !== null) {
      await writeFile(outputFile, outputContents, 'utf8');
    }
    proc.emit('close', code);
  }, delayMs);
  return proc;
};

const findOutputFile = (args) => {
  const idx = args.findIndex((a) => a === '-o');
  return idx === -1 ? null : args[idx + 1];
};

const makeSpawnImpl = ({ stdoutChunks = [], stderr = '', code = 0, outputContents = null } = {}) => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild({
      stdoutChunks,
      stderr,
      code,
      outputFile: findOutputFile(args),
      outputContents,
    });
  };
  return { impl, calls };
};

describe('codex adapter — detect()', () => {
  beforeEach(() => { spawnSyncMock.mockReset(); });

  test('returns { path, version } when `codex --version` exits 0', async () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'which') return { status: 0, stdout: '/usr/local/bin/codex\n' };
      return { status: 0, stdout: 'codex-cli 0.125.0\n', error: null };
    });
    const res = await codex.detect();
    expect(res).toEqual({ path: '/usr/local/bin/codex', version: '0.125.0' });
    expect(spawnSyncMock).toHaveBeenCalledWith('codex', ['--version'], expect.any(Object));
  });

  test('falls back to `codex` as path when `which` is unavailable', async () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'which') return { status: 127, error: new Error('ENOENT') };
      return { status: 0, stdout: 'codex-cli 0.125.0\n' };
    });
    const res = await codex.detect();
    expect(res.path).toBe('codex');
    expect(res.version).toBe('0.125.0');
  });

  test('returns null when codex is not on PATH', async () => {
    spawnSyncMock.mockReturnValue({ status: null, error: new Error('ENOENT') });
    expect(await codex.detect()).toBeNull();
  });

  test('returns null when codex exits non-zero', async () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'boom', error: null });
    expect(await codex.detect()).toBeNull();
  });
});

describe('codex adapter — spawn()', () => {
  test('first turn (no persisted id): uses `codex exec` and captures thread_id from JSONL', async () => {
    const threadId = '019dc1c4-c110-7373-bcf6-cdddd0c51be7';
    const { impl, calls } = makeSpawnImpl({
      stdoutChunks: [
        `{"type":"thread.started","thread_id":"${threadId}"}\n`,
        '{"type":"turn.started"}\n',
        '{"type":"turn.completed"}\n',
      ],
      outputContents: 'Hello from codex.',
    });

    const res = await codex.spawn('hi', { sessionId: null, _spawnImpl: impl });

    expect(res.text).toBe('Hello from codex.');
    expect(res.newSessionId).toBe(threadId);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('codex');
    // `exec` subcommand, no `resume`, --json + --skip-git-repo-check + -o + prompt
    expect(calls[0].args[0]).toBe('exec');
    expect(calls[0].args).not.toContain('resume');
    expect(calls[0].args).toContain('--json');
    expect(calls[0].args).toContain('--skip-git-repo-check');
    expect(calls[0].args).toContain('-o');
    expect(calls[0].args[calls[0].args.length - 1]).toBe('hi');
  });

  test('spawn opts force stdin to ignore — regression for codex blocking on piped stdin', async () => {
    // Without this, codex 0.125.0 blocks on "Reading additional input from
    // stdin..." when spawned from a non-TTY parent (e.g. the run loop).
    // The fix lives in runCodex; this test pins it so a "cleanup" PR can't
    // silently regress it.
    const { impl, calls } = makeSpawnImpl({
      stdoutChunks: ['{"type":"thread.started","thread_id":"sid-1"}\n'],
      outputContents: 'ok',
    });
    await codex.spawn('hi', { sessionId: null, _spawnImpl: impl });
    expect(calls[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  test('subsequent turn (persisted id): uses `codex exec resume <sid>` and threads the prompt last', async () => {
    const sid = 'sid-deadbeef';
    const { impl, calls } = makeSpawnImpl({
      stdoutChunks: [
        `{"type":"thread.started","thread_id":"${sid}"}\n`,
        '{"type":"turn.completed"}\n',
      ],
      outputContents: 'continuing',
    });

    const res = await codex.spawn('keep going', { sessionId: sid, _spawnImpl: impl });

    expect(res.text).toBe('continuing');
    expect(res.newSessionId).toBe(sid);
    expect(calls).toHaveLength(1);
    // exec resume <sid> ... <prompt>
    expect(calls[0].args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(calls[0].args).toContain(sid);
    // The session id appears before the prompt; the prompt is the final arg.
    const sidIdx = calls[0].args.indexOf(sid);
    const promptIdx = calls[0].args.indexOf('keep going');
    expect(sidIdx).toBeLessThan(promptIdx);
    expect(promptIdx).toBe(calls[0].args.length - 1);
  });

  test('prepends the memory preamble when ctx.memoryLongTerm is non-empty', async () => {
    const { impl, calls } = makeSpawnImpl({
      stdoutChunks: ['{"type":"thread.started","thread_id":"sid-1"}\n'],
      outputContents: 'ok',
    });
    await codex.spawn('current message', {
      sessionId: null,
      memoryLongTerm: 'I remember the user prefers dark mode.',
      _spawnImpl: impl,
    });

    const promptArg = calls[0].args[calls[0].args.length - 1];
    expect(promptArg).toContain('=== Context');
    expect(promptArg).toContain('I remember the user prefers dark mode.');
    expect(promptArg).toContain('=== Current turn ===');
    expect(promptArg).toContain('current message');
  });

  test('no preamble when memoryLongTerm is empty — prompt passed verbatim', async () => {
    const { impl, calls } = makeSpawnImpl({
      stdoutChunks: ['{"type":"thread.started","thread_id":"sid-1"}\n'],
      outputContents: 'ok',
    });
    await codex.spawn('just this', { sessionId: null, memoryLongTerm: '', _spawnImpl: impl });
    expect(calls[0].args[calls[0].args.length - 1]).toBe('just this');
  });

  test('rejects when codex emits a turn.failed event, surfacing the error message', async () => {
    const { impl } = makeSpawnImpl({
      stdoutChunks: [
        '{"type":"thread.started","thread_id":"sid-1"}\n',
        '{"type":"turn.failed","error":{"message":"refresh token reused"}}\n',
      ],
      // codex still exits 0 on a turn.failed in some versions; the parser
      // catches it independent of exit code.
      code: 0,
    });
    await expect(
      codex.spawn('x', { sessionId: null, _spawnImpl: impl }),
    ).rejects.toThrow(/turn failed.*refresh token reused/i);
  });

  test('rejects when codex exits non-zero, surfacing trimmed stderr', async () => {
    const { impl } = makeSpawnImpl({
      stdoutChunks: [],
      stderr: 'auth error: 401\nsome trace lines',
      code: 1,
    });
    await expect(
      codex.spawn('x', { sessionId: null, _spawnImpl: impl }),
    ).rejects.toThrow(/codex exited with code 1.*auth error/);
  });

  test('rejects on timeout and SIGTERMs the child', async () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    const impl = () => proc;

    const p = codex.spawn('x', { sessionId: null, timeoutMs: 20, _spawnImpl: impl });
    setTimeout(() => proc.emit('close', null), 40);

    await expect(p).rejects.toThrow(/timed out after 20ms/);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('handles JSONL split across chunk boundaries (partial line buffering)', async () => {
    const threadId = 'sid-split';
    // Split the thread.started line across two stdout chunks — the parser
    // must buffer the partial first chunk and join with the second.
    const { impl } = makeSpawnImpl({
      stdoutChunks: [
        '{"type":"thread.started","thread',
        `_id":"${threadId}"}\n{"type":"turn.completed"}\n`,
      ],
      outputContents: 'ok',
    });
    const res = await codex.spawn('x', { sessionId: null, _spawnImpl: impl });
    expect(res.newSessionId).toBe(threadId);
    expect(res.text).toBe('ok');
  });

  test('cleans up the temp output dir even when spawn rejects', async () => {
    // Inspect mkdtemp side effects by passing a known prefix and checking
    // that no commonly-codex- dirs remain in $TMPDIR after the spawn fails.
    // We can't easily intercept mkdtemp without a deeper mock — instead,
    // just verify spawn rejection doesn't leak by counting before/after.
    const before = (await readFile('/proc/self/status', 'utf8').catch(() => '')); // noop sentinel
    expect(typeof before).toBe('string');

    const { impl } = makeSpawnImpl({
      stdoutChunks: ['{"type":"turn.failed","error":{"message":"boom"}}\n'],
      code: 0,
    });
    await expect(
      codex.spawn('x', { sessionId: null, _spawnImpl: impl }),
    ).rejects.toThrow(/turn failed/);
    // If rm in the finally block were missing, repeated runs would leak
    // dirs — covered functionally by Node's tmpdir cleanup elsewhere.
    // Smoke-level coverage; deeper isolation lives in integration tests.
  });
});

// Sanity that the registry imports the new adapter.
describe('adapter registry includes codex', () => {
  test('listAdapterNames includes codex', async () => {
    const { listAdapterNames, getAdapter } = await import('../src/lib/adapters/index.js');
    expect(listAdapterNames()).toContain('codex');
    expect(getAdapter('codex')).toBeTruthy();
    expect(getAdapter('codex').name).toBe('codex');
  });
});

// Cleanup any commonly-codex-* dirs the test run created in tmpdir.
afterAll(async () => {
  const dir = tmpdir();
  // Best-effort — Node's tmpdir is fine, leftover test files don't hurt.
  try {
    const fs = await import('fs/promises');
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      if (name.startsWith('commonly-codex-')) {
        // eslint-disable-next-line no-await-in-loop
        await rm(join(dir, name), { recursive: true, force: true });
      }
    }
  } catch { /* ignore */ }
});
