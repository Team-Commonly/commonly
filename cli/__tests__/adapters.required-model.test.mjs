import { jest } from '@jest/globals';
// Refusal regressions must remain offline even when the guard is mutated away.
const childProcess = jest.fn(() => { throw new Error('unexpected subprocess'); });
await jest.unstable_mockModule('child_process', () => ({ spawn: childProcess, spawnSync: childProcess }));
await jest.unstable_mockModule('node:child_process', () => ({ spawn: childProcess, spawnSync: childProcess }));
const { getAdapter, listAdapterNames } = await import('../src/lib/adapters/index.js');
beforeEach(() => { childProcess.mockClear(); });

const adapters = listAdapterNames().filter((name) => name !== 'stub');

describe.each(adapters)('%s requires the seat model before any subprocess', (name) => {
  test('declares the pre-credential model requirement', () => {
    expect(getAdapter(name).requiresModel).toBe(true);
  });
  test('refuses a missing spawn context', async () => {
    await expect(getAdapter(name).spawn('hello')).rejects.toThrow(`${name} requires environment.model`);
    expect(childProcess).not.toHaveBeenCalled();
  });
  test.each([undefined, {}, { model: null }, { model: '' }, { model: ' \t\n' }, { model: 42 }])(
    'refuses missing or invalid declaration %p even with operator defaults', async (environment) => {
      const spawn = jest.fn(() => { throw new Error('must not spawn'); });
      await expect(getAdapter(name).spawn('hello', {
        environment,
        env: { HOME: '/operator-home', GOOSE_MODEL: 'operator-model', OPENAI_MODEL: 'operator-model' },
        _spawnImpl: spawn,
        _spawnSyncImpl: spawn,
      })).rejects.toThrow(`${name} requires environment.model`);
      expect(spawn).not.toHaveBeenCalled();
      expect(childProcess).not.toHaveBeenCalled();
    },
  );
});
