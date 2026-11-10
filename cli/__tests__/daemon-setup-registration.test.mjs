// F370: `daemon setup` on a computer that is already registered for the same
// instance skips login and register, so running setup again is how a setup
// install updates. Only a stored key the server still accepts counts.
import { jest } from '@jest/globals';
import { setupFindsRegistration } from '../src/commands/daemon.js';

const record = { instanceUrl: 'https://x.example/', daemonToken: 'test-daemon-key', machineDbId: 'm1', machineId: 'h1' };

describe('setupFindsRegistration', () => {
  test('an active key for the same instance counts, whatever its trailing slash', async () => {
    const clientFor = jest.fn(() => ({ fake: true }));
    const state = jest.fn(async () => 'active');
    await expect(setupFindsRegistration({
      instance: 'https://x.example', load: () => record, state, clientFor,
    })).resolves.toBe(true);
    expect(clientFor).toHaveBeenCalledWith({ instance: record.instanceUrl, token: record.daemonToken });
    expect(state).toHaveBeenCalledWith({ fake: true }, record);
  });

  test('a revoked or missing key goes through register, which replaces it', async () => {
    for (const s of ['revoked', 'missing']) {
      await expect(setupFindsRegistration({
        instance: 'https://x.example', load: () => record, state: async () => s, clientFor: () => ({}),
      })).resolves.toBe(false);
    }
  });

  test('no record, no instance, or another instance: not registered here, and no call is made', async () => {
    const state = jest.fn();
    await expect(setupFindsRegistration({ instance: 'https://x.example', load: () => null, state })).resolves.toBe(false);
    await expect(setupFindsRegistration({ instance: '', load: () => record, state })).resolves.toBe(false);
    await expect(setupFindsRegistration({ instance: 'https://other.example', load: () => record, state })).resolves.toBe(false);
    expect(state).not.toHaveBeenCalled();
  });
});
