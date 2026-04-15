/**
 * adapters.claude.test.mjs — ADR-005 Phase 1b
 *
 * Covers the claude-CLI adapter. The real `claude` binary is never invoked
 * here: `child_process.spawnSync` is mocked at the module level for detect(),
 * and the adapter's `_spawnImpl` test seam (ctx field) replaces childSpawn
 * for spawn(). Both are internal-only seams — production code never touches
 * `_spawnImpl`.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

// Mock child_process.spawnSync used by detect(). We leave `spawn` real so
// nothing else in the module breaks — the adapter uses `_spawnImpl` instead.
const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: jest.fn(),
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;

// Fake child process — returned by the injected `_spawnImpl`.
const fakeChild = ({ stdout = '', stderr = '', code = 0, delayMs = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  }, delayMs);
  return proc;
};

const makeSpawnImpl = (childOpts) => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild(childOpts);
  };
  return { impl, calls };
};

describe('claude adapter — detect()', () => {
  beforeEach(() => { spawnSyncMock.mockReset(); });

  test('returns { path, version } when `claude --version` exits 0', async () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'which') return { status: 0, stdout: '/usr/local/bin/claude\n' };
      return { status: 0, stdout: '2.5.1 (Claude Code)\n', error: null };
    });
    const res = await claude.detect();
    expect(res).toEqual({ path: '/usr/local/bin/claude', version: '2.5.1' });
    expect(spawnSyncMock).toHaveBeenCalledWith('claude', ['--version'], expect.any(Object));
  });

  test('falls back to `claude` as path when `which` is unavailable (e.g. Windows)', async () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'which') return { status: 127, error: new Error('ENOENT') };
      return { status: 0, stdout: '2.5.1\n' };
    });
    const res = await claude.detect();
    expect(res.path).toBe('claude');
    expect(res.version).toBe('2.5.1');
  });

  test('returns null when claude is not on PATH (spawnSync error)', async () => {
    spawnSyncMock.mockReturnValue({ status: null, error: new Error('ENOENT') });
    expect(await claude.detect()).toBeNull();
  });

  test('returns null when claude exits non-zero', async () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'boom', error: null });
    expect(await claude.detect()).toBeNull();
  });
});

describe('claude adapter — spawn()', () => {
  test('builds argv with -p <prompt> --output-format text --session-id <sid>', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: 'hello\n' });
    const res = await claude.spawn('hello world', {
      sessionId: 'sid-123',
      cwd: '/tmp/commonly-agents/my-claude',
      env: {},
      memoryLongTerm: '',
      _spawnImpl: impl,
    });

    expect(res.text).toBe('hello');
    expect(res.newSessionId).toBe('sid-123');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).toEqual(
      ['-p', 'hello world', '--output-format', 'text', '--session-id', 'sid-123'],
    );
  });

  test('mints a new session id on first turn when ctx.sessionId is null', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: 'ok' });
    const res = await claude.spawn('hi', { sessionId: null, _spawnImpl: impl });

    // UUID v4 shape: 8-4-4-4-12 hex groups.
    expect(res.newSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(calls[0].args).toContain(res.newSessionId);
  });

  test('prepends the memory preamble when ctx.memoryLongTerm is non-empty', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: 'ok' });
    await claude.spawn('current message', {
      sessionId: 'sid-1',
      memoryLongTerm: 'I remember the user prefers dark mode.',
      _spawnImpl: impl,
    });

    const promptArg = calls[0].args[1]; // args = ['-p', <prompt>, ...]
    expect(promptArg).toContain('=== Context');
    expect(promptArg).toContain('I remember the user prefers dark mode.');
    expect(promptArg).toContain('=== Current turn ===');
    expect(promptArg).toContain('current message');
  });

  test('no preamble when memoryLongTerm is empty — prompt passed verbatim', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: 'ok' });
    await claude.spawn('just this', { sessionId: 'sid-1', memoryLongTerm: '', _spawnImpl: impl });
    expect(calls[0].args[1]).toBe('just this');
  });

  test('rejects when claude exits non-zero, surfacing stderr', async () => {
    const { impl } = makeSpawnImpl({ stdout: '', stderr: 'auth error', code: 1 });
    await expect(
      claude.spawn('x', { sessionId: 'sid-1', _spawnImpl: impl }),
    ).rejects.toThrow(/claude exited with code 1.*auth error/);
  });

  test('rejects on timeout and SIGTERMs the child', async () => {
    // Child never emits close within the window.
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    const impl = () => proc;

    const p = claude.spawn('x', { sessionId: 'sid-1', timeoutMs: 20, _spawnImpl: impl });
    // After kill, simulate the process closing so the adapter resolves its close handler.
    setTimeout(() => proc.emit('close', null), 40);

    await expect(p).rejects.toThrow(/timed out after 20ms/);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
