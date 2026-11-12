/**
 * F453. The sandbox check on a public seat's provider key file lives once, in
 * the shared resolver (src/lib/provider-proxy.js). An adapter gets it only by
 * handing that resolver its environment, so this pins that every adapter with
 * a shared provider block does, for the same environment it validates. The
 * list is fixed: a new adapter belongs here too.
 */
import { jest } from '@jest/globals';

const resolveProviderKeyFile = jest.fn(async () => '/keys/provider.key');
const actual = await import('../src/lib/provider-proxy.js');
await jest.unstable_mockModule('../src/lib/provider-proxy.js', () => ({ ...actual, resolveProviderKeyFile }));

const { default: goose } = await import('../src/lib/adapters/goose.js');
const { default: qwen } = await import('../src/lib/adapters/qwen.js');
const { default: opencode } = await import('../src/lib/adapters/opencode.js');
const { default: pi } = await import('../src/lib/adapters/pi.js');
const { default: dsh, TESTED_DSH_VERSIONS } = await import('../src/lib/adapters/dsh.js');

const environment = {
  model: 'owner-model',
  provider: { id: 'owner', baseURL: 'https://models.example/v1', keyFile: '/keys/provider.key' },
};

beforeEach(() => resolveProviderKeyFile.mockClear());

test.each([['goose', goose], ['qwen', qwen], ['opencode', opencode], ['pi', pi]])(
  '%s hands the shared resolver the environment it is validating',
  async (_name, adapter) => {
    await adapter.validateEnvironment(environment, '/work');
    expect(resolveProviderKeyFile).toHaveBeenCalledTimes(1);
    const [provider, workspace, , options] = resolveProviderKeyFile.mock.calls[0];
    expect(provider).toBe(environment.provider);
    expect(workspace).toBe('/work');
    expect(options.environment).toBe(environment);
  },
);

// dsh confines a private seat (mode workspace, restricted network), so it says
// so itself rather than leaving the resolver to read public trust.
test.each([
  ['unconfined', {}, false],
  ['confined', { sandbox: { mode: 'workspace', network: { policy: 'restricted' } } }, true],
])('dsh hands over the environment and whether its %s run is sandboxed', async (_label, extra, sandboxed) => {
  const env = { ...environment, ...extra };
  const probed = { ...dsh, detect: async () => ({ version: TESTED_DSH_VERSIONS[0] }) };
  await dsh.validateEnvironment.call(probed, env, '/work');
  const [, , , options] = resolveProviderKeyFile.mock.calls[0];
  expect(options.environment).toBe(env);
  expect(options.sandboxed).toBe(sandboxed);
});
