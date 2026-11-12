/**
 * F453. The sandbox check on a public seat's provider key file lives once, in
 * the shared resolver (src/lib/provider-proxy.js). An adapter gets it only by
 * handing that resolver its environment, so this pins that every adapter with
 * a shared provider block does, for the same environment it validates, and
 * that the adapters whose sandbox holds a stable seat home name it. The list is
 * fixed: a new adapter belongs here too.
 */
import { jest } from '@jest/globals';
import {
  chmod, mkdir, mkdtemp, realpath, rm, writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

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

// Spawn: the mocked resolver stops the turn at the key check, which is all
// this needs to see.
describe('the spawn path names the seat home the sandbox is given', () => {
  let root;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'wiring-seat-home-')));
    await mkdir(join(root, 'work'));
    resolveProviderKeyFile.mockImplementation(async () => { throw new Error('stopped at the key check'); });
  });
  afterEach(async () => {
    resolveProviderKeyFile.mockImplementation(async () => '/keys/provider.key');
    await rm(root, { recursive: true, force: true });
  });

  test('opencode, public: its data home', async () => {
    const seatRoot = join(root, 'opencode-home');
    await expect(opencode.spawn('hi', {
      cwd: join(root, 'work'), agentName: 'kai', instanceUrl: 'https://api.example', runtimeToken: 'cm_agent_x',
      environment: { ...environment, sandbox: { trust: 'public', mode: 'workspace' } },
      _opencodeHomeRoot: seatRoot, _platform: 'darwin',
    })).rejects.toThrow('stopped at the key check');
    const [, , , options] = resolveProviderKeyFile.mock.calls[0];
    expect(options.seatDirectories).toEqual([seatRoot]);
  });

  test('dsh, confined: its seat home', async () => {
    const home = join(root, 'dsh-home');
    const binary = join(root, 'dsh');
    await writeFile(binary, `#!/bin/sh\necho "dsh ${TESTED_DSH_VERSIONS[0]}"\n`);
    await chmod(binary, 0o755);
    await expect(dsh.spawn('hi', {
      cwd: join(root, 'work'), agentName: 'kai', instanceUrl: 'https://api.example', runtimeToken: 'cm_agent_x',
      environment: { ...environment, sandbox: { mode: 'workspace', network: { policy: 'restricted' } } },
      _dshHome: home, _dshBinary: binary, _platform: 'darwin',
      _detectSeatbelt: () => ({ available: true }),
      env: { PATH: '/usr/bin:/bin' },
    })).rejects.toThrow('stopped at the key check');
    const [, , , options] = resolveProviderKeyFile.mock.calls[0];
    expect(options).toMatchObject({ sandboxed: true, seatDirectories: [home] });
  });
});
