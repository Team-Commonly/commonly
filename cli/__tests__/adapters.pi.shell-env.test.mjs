import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const execute = jest.fn();
const localExec = jest.fn();
const createBashTool = jest.fn(() => ({ name: 'bash', execute }));
// pi resolves its own bundled SDK inside its extension loader. It is not a CLI
// dependency, so link that import explicitly while evaluating the shipped file.
const context = createContext({ process });
const sdk = new SyntheticModule(['createBashTool', 'createLocalBashOperations'], function linkSdk() {
  this.setExport('createBashTool', createBashTool);
  this.setExport('createLocalBashOperations', () => ({ exec: localExec }));
}, { context });
const extension = new SourceTextModule(readFileSync(new URL('../src/lib/adapters/pi-shell-env.mjs', import.meta.url), 'utf8'), { context });
await extension.link((name) => {
  expect(name).toBe('@earendil-works/pi-coding-agent');
  return sdk;
});
await extension.evaluate();
const install = extension.namespace.default;

let tool;
let manual;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.COMMONLY_PI_PROVIDER_KEY_ENV = 'CUSTOM_PROVIDER_KEY';
  process.env.CUSTOM_PROVIDER_KEY = 'fake-provider-key';
  process.env.COMMONLY_LITELLM_KEY = 'fake-default-key';
  install({
    registerTool(value) { tool = value; },
    on(name, handler) { expect(name).toBe('user_bash'); manual = handler; },
  });
});
afterEach(() => {
  delete process.env.COMMONLY_PI_PROVIDER_KEY_ENV;
  delete process.env.CUSTOM_PROVIDER_KEY;
  delete process.env.COMMONLY_LITELLM_KEY;
});

test('model bash strips the configured and default keys without mutating provider auth', async () => {
  const hook = createBashTool.mock.calls[0][1].spawnHook;
  const env = { ...process.env, SAFE_VALUE: 'keep' };
  const result = hook({ command: 'env', cwd: '/seat', env });
  expect(result.command).toBe('env');
  expect(result.cwd).toBe('/seat');
  expect(result.env.CUSTOM_PROVIDER_KEY).toBeUndefined();
  expect(result.env.COMMONLY_LITELLM_KEY).toBeUndefined();
  expect(result.env.COMMONLY_PI_PROVIDER_KEY_ENV).toBeUndefined();
  expect(result.env.SAFE_VALUE).toBe('keep');
  expect(env.CUSTOM_PROVIDER_KEY).toBe('fake-provider-key');
  expect(process.env.CUSTOM_PROVIDER_KEY).toBe('fake-provider-key');

  execute.mockResolvedValue('result');
  await expect(tool.execute('id', { command: 'pwd' }, 'signal', 'update', { cwd: '/current' }))
    .resolves.toBe('result');
  expect(createBashTool.mock.calls[1]).toEqual(['/current', { spawnHook: hook }]);
  expect(execute).toHaveBeenCalledWith('id', { command: 'pwd' }, 'signal', 'update', { cwd: '/current' });
});

test('mixed-case excluded names cannot survive as plain-object keys', () => {
  const env = {
    Custom_Provider_Key: 'fake-custom', commonly_litellm_key: 'fake-default',
    Commonly_PI_Provider_Key_Env: 'CUSTOM_PROVIDER_KEY', Path: '/safe',
  };
  const hook = createBashTool.mock.calls[0][1].spawnHook;
  expect(hook({ env }).env).toEqual({ Path: '/safe' });
  manual().operations.exec('env', '/seat', { env });
  expect(localExec.mock.calls[0][2].env).toEqual({ Path: '/safe' });
  expect(env.Custom_Provider_Key).toBe('fake-custom');
});

test.each([true, false])('manual shell strips credentials with explicit env = %s', async (explicit) => {
  const env = { ...process.env, SAFE_VALUE: 'keep' };
  const options = { signal: 'signal', timeout: 10, ...(explicit ? { env } : {}) };
  localExec.mockResolvedValue({ exitCode: 0 });
  await expect(manual().operations.exec('env', '/seat', options)).resolves.toEqual({ exitCode: 0 });
  const [command, cwd, passed] = localExec.mock.calls[0];
  expect([command, cwd, passed.signal, passed.timeout]).toEqual(['env', '/seat', 'signal', 10]);
  expect(passed.env.CUSTOM_PROVIDER_KEY).toBeUndefined();
  expect(passed.env.COMMONLY_LITELLM_KEY).toBeUndefined();
  expect(passed.env.COMMONLY_PI_PROVIDER_KEY_ENV).toBeUndefined();
  if (explicit) expect(passed.env.SAFE_VALUE).toBe('keep');
  expect(env.CUSTOM_PROVIDER_KEY).toBe('fake-provider-key');
  expect(process.env.CUSTOM_PROVIDER_KEY).toBe('fake-provider-key');
});

test('missing provider-key metadata refuses extension setup', () => {
  delete process.env.COMMONLY_PI_PROVIDER_KEY_ENV;
  expect(() => install({})).toThrow('missing provider key environment name');
});
