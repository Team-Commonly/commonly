/**
 * adapters.cursor.test.mjs — Cursor CLI adapter (ADR-005).
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: jest.fn(),
}));

const cursor = (await import('../src/lib/adapters/cursor.js')).default;

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

const versionOk = (stdout, path = '/usr/local/bin/cursor-agent') => {
  spawnSyncMock.mockImplementation((cmd, args) => {
    if (cmd === 'which') return { status: 0, stdout: `${path}\n` };
    if (args?.[0] === '--version') {
      return { status: 0, stdout, stderr: '', error: null };
    }
    return { status: 1, error: new Error('unexpected') };
  });
};

describe('cursor adapter — detect()', () => {
  beforeEach(() => { spawnSyncMock.mockReset(); });

  test('accepts cursor-agent when --version exits 0', async () => {
    versionOk('cursor-agent 1.2.3\n', '/opt/cursor/bin/cursor-agent');
    const res = await cursor.detect();
    expect(res).toEqual({ path: '/opt/cursor/bin/cursor-agent', version: '1.2.3' });
    expect(spawnSyncMock).toHaveBeenCalledWith('cursor-agent', ['--version'], expect.any(Object));
  });

  test('rejects generic agent when version text and path do not mention cursor', async () => {
    spawnSyncMock.mockImplementation((cmd, args) => {
      if (cmd === 'cursor-agent') return { status: 1, error: new Error('ENOENT') };
      if (cmd === 'which') return { status: 0, stdout: '/usr/bin/agent\n' };
      if (cmd === 'agent' && args?.[0] === '--version') {
        return { status: 0, stdout: 'pi-agent 0.4.0\n', error: null };
      }
      return { status: 1 };
    });
    expect(await cursor.detect()).toBeNull();
  });

  test('accepts agent when version output mentions cursor', async () => {
    spawnSyncMock.mockImplementation((cmd, args) => {
      if (cmd === 'cursor-agent') return { status: 1, error: new Error('ENOENT') };
      if (cmd === 'which') return { status: 127, error: new Error('ENOENT') };
      if (cmd === 'agent' && args?.[0] === '--version') {
        return { status: 0, stdout: 'Cursor Agent 2.0.1\n', error: null };
      }
      return { status: 1 };
    });
    const res = await cursor.detect();
    expect(res).toEqual({ path: 'agent', version: '2.0.1' });
  });

  test('accepts agent when resolved path contains cursor', async () => {
    spawnSyncMock.mockImplementation((cmd, args) => {
      if (cmd === 'cursor-agent') return { status: 1, error: new Error('ENOENT') };
      if (cmd === 'which') return { status: 0, stdout: 'C:\\Users\\me\\AppData\\Local\\cursor\\agent.exe\n' };
      if (cmd === 'agent' && args?.[0] === '--version') {
        return { status: 0, stdout: '2.0.1\n', error: null };
      }
      return { status: 1 };
    });
    const res = await cursor.detect();
    expect(res?.path.toLowerCase()).toContain('cursor');
  });
});

describe('cursor adapter — spawn()', () => {
  beforeEach(() => { spawnSyncMock.mockReset(); });

  test('fresh turn argv and JSON result + session_id', async () => {
    versionOk('1.0.0\n');
    const payload = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'hello from cursor',
      session_id: 'sess-abc',
    });
    const { impl, calls } = makeSpawnImpl({ stdout: payload });
    const res = await cursor.spawn('do work', {
      sessionId: null,
      cwd: 'C:\\repo',
      memoryLongTerm: '',
      environment: { model: 'composer-2.5' },
      _spawnImpl: impl,
    });

    expect(res).toEqual({ text: 'hello from cursor', newSessionId: 'sess-abc' });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('cursor-agent');
    expect(calls[0].args).toEqual([
      '-p', '--output-format', 'json', '--trust', '--force',
      '--model', 'composer-2.5',
      '--workspace', 'C:\\repo',
      expect.stringContaining('do work'),
    ]);
    expect(calls[0].args).not.toContain('--resume');
    expect(calls[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  test('resume turn passes --resume', async () => {
    versionOk('1.0.0\n');
    const payload = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'continued',
      session_id: 'sess-abc',
    });
    const { impl, calls } = makeSpawnImpl({ stdout: payload });
    await cursor.spawn('next', {
      sessionId: 'sess-abc',
      memoryLongTerm: '',
      _spawnImpl: impl,
    });
    expect(calls[0].args).toContain('--resume');
    expect(calls[0].args).toContain('sess-abc');
  });

  test('non-zero exit throws', async () => {
    versionOk('1.0.0\n');
    const { impl } = makeSpawnImpl({ stderr: 'boom', code: 1 });
    await expect(cursor.spawn('x', { _spawnImpl: impl })).rejects.toThrow(/cursor/);
  });

  test('is_error in JSON throws', async () => {
    versionOk('1.0.0\n');
    const payload = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'model refused',
      session_id: 'sess-x',
    });
    const { impl } = makeSpawnImpl({ stdout: payload, code: 0 });
    await expect(cursor.spawn('x', { _spawnImpl: impl })).rejects.toThrow(/model refused|cursor/);
  });
});
