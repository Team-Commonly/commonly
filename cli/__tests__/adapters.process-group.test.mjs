/**
 * The claude and codex adapters start their child in its own process group
 * only when the run supervisor asks (ctx.ownProcessGroup), because only the
 * supervisor kills the group. Live seats run unsupervised, and their spawn
 * options must stay exactly what they were.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  spawn: jest.fn(),
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;
const codex = (await import('../src/lib/adapters/codex.js')).default;
const { LEADS_PROCESS_GROUP, OWN_PROCESS_GROUP } = await import('@commonlyai/seats/process-group');

const makeSpawnImpl = () => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    calls.push({ cmd, args, opts, proc });
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('ok'));
      proc.emit('close', 0);
    }, 0);
    return proc;
  };
  return { impl, calls };
};

const ADAPTERS = [['claude', claude], ['codex', codex]];
const POSIX = process.platform !== 'win32';

describe.each(ADAPTERS)('%s adapter — process group', (name, adapter) => {
  test('unsupervised: spawns with exactly cwd, env and stdio, no detached, no marker', async () => {
    const { impl, calls } = makeSpawnImpl();
    await adapter.spawn('hi', { environment: { model: 'test-model' }, sessionId: null, _spawnImpl: impl });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].opts).sort()).toEqual(['cwd', 'env', 'stdio']);
    expect(calls[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(calls[0].proc[LEADS_PROCESS_GROUP]).toBeUndefined();
  });

  (POSIX ? test : test.skip)('supervised: spawns detached and marks the child as leading its group', async () => {
    const { impl, calls } = makeSpawnImpl();
    await adapter.spawn('hi', {
      environment: { model: 'test-model' }, sessionId: null, _spawnImpl: impl, [OWN_PROCESS_GROUP]: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.detached).toBe(true);
    expect(Object.keys(calls[0].opts).sort()).toEqual(['cwd', 'detached', 'env', 'stdio']);
    expect(calls[0].proc[LEADS_PROCESS_GROUP]).toBe(true);
  });

  test('a truthy non-true value does not opt in', async () => {
    const { impl, calls } = makeSpawnImpl();
    await adapter.spawn('hi', {
      environment: { model: 'test-model' }, sessionId: null, _spawnImpl: impl, [OWN_PROCESS_GROUP]: 'yes',
    });
    expect(calls[0].opts).not.toHaveProperty('detached');
  });
});
