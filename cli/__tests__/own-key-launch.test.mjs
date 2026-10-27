import { jest } from '@jest/globals';
import { createOwnKeyResolver } from '../src/lib/own-key-launch.js';
import { openSpawnCredential } from '../src/lib/spawn-credential.js';
const provider = { id: 'p', baseURL: 'https://provider.invalid/v1' };
const options = { instanceUrl: 'https://instance.invalid', machineId: 'machine', agentName: 'seat' };
const record = { ...options, daemonToken: 'cm_daemon_parent' };
const resolver = (launch = { set: true, key: 'private-material' }) => {
  const post = jest.fn(async () => launch);
  const clientFactory = jest.fn(() => ({ post }));
  return { resolve: createOwnKeyResolver({ ...options, loadRecord: () => record, clientFactory }), post, clientFactory };
};
test.each([429, 500, 503, 404])('mint HTTP %i fallback cannot start an own-key child', async (status) => {
  const opened = await openSpawnCredential({ client: { post: async () => { throw Object.assign(new Error('mint'), { status }); } },
    seatToken: 'seat-fallback-bearer', spawnId: 'turn' });
  expect(opened.source).toBe('seat-fallback');
  const { resolve, clientFactory } = resolver();
  const spawn = jest.fn();
  await expect((async () => {
    const providerKey = await resolve({ opened, harness: 'opencode', provider });
    spawn({ providerKey, runtimeToken: opened.token });
  })()).rejects.toThrow('scoped spawn credential');
  expect(spawn).not.toHaveBeenCalled();
  expect(clientFactory).toHaveBeenCalledWith({ instance: options.instanceUrl, token: record.daemonToken });
});
test('minted child uses a separate daemon launch request; fallback without an own key stays compatible', async () => {
  const { resolve, post } = resolver();
  await expect(resolve({ opened: { source: 'spawn' }, harness: 'opencode', provider })).resolves.toBe('private-material');
  expect(post).toHaveBeenCalledWith('/api/agents/runtime/provider-key/launch', { agentName: 'seat', instanceId: 'default',
    harness: 'opencode', providerId: 'p', baseURL: provider.baseURL, metadataOnly: false });
  await expect(resolver({ set: false }).resolve({ opened: { source: 'seat-fallback' }, harness: 'opencode', provider })).resolves.toBeUndefined();
});
test.each([null, { ...record, machineId: 'other' }, { ...record, instanceUrl: 'https://other.invalid' }])('missing or mismatched daemon refuses before sending', async (daemonRecord) => {
  const clientFactory = jest.fn();
  const resolve = createOwnKeyResolver({ ...options, loadRecord: () => daemonRecord, clientFactory });
  await expect(resolve({ opened: { source: 'spawn' }, harness: 'opencode', provider })).rejects.toThrow('registered daemon');
  expect(clientFactory).not.toHaveBeenCalled();
});

test.each([['claude', provider], ['codex', provider], ['hermes', provider], ['dsh', provider], ['opencode', undefined]])('unavailable own-key scope %s never reads credentials or calls launch', async (harness, selectedProvider) => {
  const loadRecord = jest.fn(); const clientFactory = jest.fn();
  const resolve = createOwnKeyResolver({ ...options, loadRecord, clientFactory });
  await expect(resolve({ opened: { source: 'spawn' }, harness, provider: selectedProvider })).resolves.toBeUndefined();
  expect(loadRecord).not.toHaveBeenCalled(); expect(clientFactory).not.toHaveBeenCalled();
});
