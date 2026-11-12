/**
 * F453. The sandbox check on a public seat's provider key file lives once, in
 * the shared resolver (src/lib/provider-proxy.js). An adapter gets it only by
 * handing that resolver its environment, so this pins that every adapter with
 * a shared provider block does, for the same environment it validates. A new
 * adapter that calls the resolver without one fails here.
 */
import { jest } from '@jest/globals';

const resolveProviderKeyFile = jest.fn(async () => '/keys/provider.key');
const actual = await import('../src/lib/provider-proxy.js');
await jest.unstable_mockModule('../src/lib/provider-proxy.js', () => ({ ...actual, resolveProviderKeyFile }));

const { default: goose } = await import('../src/lib/adapters/goose.js');
const { default: qwen } = await import('../src/lib/adapters/qwen.js');
const { default: opencode } = await import('../src/lib/adapters/opencode.js');
const { default: pi } = await import('../src/lib/adapters/pi.js');

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
