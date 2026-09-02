import { jest } from '@jest/globals';
import * as os from 'os';

const createClient = jest.fn();
const saveInstance = jest.fn();
const listInstances = jest.fn();
const waitForDeviceAuthorization = jest.fn();

await jest.unstable_mockModule('../src/lib/api.js', () => ({
  createClient,
  login: jest.fn(),
}));
await jest.unstable_mockModule('../src/lib/config.js', () => ({ saveInstance, listInstances }));
await jest.unstable_mockModule('../src/lib/device-login.js', () => ({
  DeviceLoginCancelledError: class DeviceLoginCancelledError extends Error {},
  DeviceLoginDeniedError: class DeviceLoginDeniedError extends Error {},
  DeviceLoginExpiredError: class DeviceLoginExpiredError extends Error {},
  waitForDeviceAuthorization,
}));
await jest.unstable_mockModule('os', () => ({ ...os, hostname: () => 'sam-laptop' }));

const { registerLogin, registerWhoami } = await import('../src/commands/login.js');

const fakeProgram = () => {
  const commands = [];
  const program = {
    version: () => '0.1.27',
    command: jest.fn(() => {
      const command = {
        description: () => command,
        option: () => command,
        addHelpText: () => command,
        action: (handler) => { command.handler = handler; return command; },
      };
      commands.push(command);
      return command;
    }),
  };
  return { program, commands };
};

afterEach(() => {
  jest.clearAllMocks();
});

test('prints the device-login and mixed-profile expiry transcript', async () => {
  const { program, commands } = fakeProgram();
  const client = { post: jest.fn().mockResolvedValue({
    deviceCode: 'private-device-code',
    userCode: 'ABCD-EFGH',
    verifyUrl: 'https://commonly.example/cli/authorize',
    expiresIn: 600,
    interval: 5,
  }) };
  createClient.mockReturnValue(client);
  waitForDeviceAuthorization.mockResolvedValue({ token: 'cm_once', username: 'lily', userId: 'u1' });
  listInstances.mockReturnValue([
    { key: 'dev', url: 'https://api.example.test', username: 'lily', active: true, token: 'cm_once', tokenType: 'device' },
    { key: 'legacy', url: 'https://legacy.example.test', username: 'lily', active: false, token: `h.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.s`, tokenType: 'jwt' },
  ]);
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  registerLogin(program);
  registerWhoami(program);
  await commands[0].handler({ instance: 'https://api.example.test', key: 'dev' });
  await commands[1].handler();

  const transcript = log.mock.calls.flat().join('\n');
  [
    'Logging in to https://api.example.test as a new device.',
    '  Open   https://commonly.example/cli/authorize',
    '  Code   ABCD-EFGH',
    'Waiting for approval… (expires in 10:00)',
    '✓ Authorized as @lily on dev (https://api.example.test)',
    'manage devices at https://commonly.example/settings/devices',
    '→ dev  lily@https://api.example.test  (device token · no expiry)',
    '  legacy  lily@https://legacy.example.test  (expired — commonly login --instance legacy)',
  ].forEach((line) => expect(transcript).toContain(line));
  expect(saveInstance).toHaveBeenCalledWith(expect.objectContaining({ token: 'cm_once', tokenType: 'device' }));
  expect(client.post).toHaveBeenCalledWith('/api/auth/device/start', expect.objectContaining({ hostname: 'sam-laptop' }));
});
