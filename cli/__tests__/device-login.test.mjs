import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import {
  DeviceLoginCancelledError,
  DeviceLoginDeniedError,
  DeviceLoginExpiredError,
  openBrowser,
  waitForDeviceAuthorization,
} from '../src/lib/device-login.js';
import { formatTokenStatus } from '../src/commands/login.js';

describe('CLI device login', () => {
  test('slows polling when asked and returns only the authorized handoff', async () => {
    const client = {
      post: jest.fn()
        .mockResolvedValueOnce({ status: 'authorization_pending' })
        .mockResolvedValueOnce({ status: 'slow_down' })
        .mockResolvedValueOnce({ status: 'authorized', token: 'cm_once', username: 'lily', userId: 'u1' }),
    };
    const waits = [];
    const statuses = [];
    const result = await waitForDeviceAuthorization({
      client,
      deviceCode: 'secret-device-code',
      userCode: 'ABCD-EFGH',
      verifyUrl: 'https://commonly.me/cli/authorize',
      stdin: new EventEmitter(),
      wait: async (ms) => waits.push(ms),
      onStatus: (message) => statuses.push(message),
      now: () => 1,
    });

    expect(result).toMatchObject({ token: 'cm_once', username: 'lily' });
    expect(waits).toEqual([5000, 10000]);
    expect(statuses).toEqual(['Waiting for browser approval (slowing down)…']);
    expect(client.post).toHaveBeenCalledWith('/api/auth/device/poll', { deviceCode: 'secret-device-code' });
  });

  test('q cancels without waiting for the device timeout', async () => {
    const stdin = new EventEmitter();
    const client = { post: jest.fn(async () => {
      stdin.emit('keypress', 'q', { name: 'q' });
      return { status: 'authorization_pending' };
    }) };

    await expect(waitForDeviceAuthorization({
      client,
      deviceCode: 'secret-device-code',
      userCode: 'ABCD-EFGH',
      verifyUrl: 'https://commonly.me/cli/authorize',
      stdin,
      // The keypress arrives after a pending response; cancellation must wake
      // the sleep rather than waiting for the next polling interval.
      wait: () => new Promise(() => {}),
      now: () => 1,
    })).rejects.toBeInstanceOf(DeviceLoginCancelledError);
  });

  test('o opens the code-prefilled authorization URL', async () => {
    const calls = [];
    await openBrowser('https://commonly.me/cli/authorize?code=ABCD-EFGH', (command, args, callback) => {
      calls.push([command, args]);
      callback(null);
    }, 'darwin');
    expect(calls).toEqual([['open', ['https://commonly.me/cli/authorize?code=ABCD-EFGH']]]);
  });

  test('uses a non-shell opener on Windows and rejects non-web verification URLs', async () => {
    const calls = [];
    await openBrowser('https://commonly.me/cli/authorize?code=ABCD-EFGH', (command, args, callback) => {
      calls.push([command, args]);
      callback(null);
    }, 'win32');
    expect(calls).toEqual([['rundll32', ['url.dll,FileProtocolHandler', 'https://commonly.me/cli/authorize?code=ABCD-EFGH']]]);
    expect(() => openBrowser('file:///etc/passwd')).toThrow('Device authorization URL must use HTTP or HTTPS.');
  });

  test('uses terminal-safe messages for denied and expired device codes', async () => {
    const denied = { post: jest.fn().mockResolvedValue({ status: 'denied' }) };
    await expect(waitForDeviceAuthorization({
      client: denied,
      deviceCode: 'secret-device-code', userCode: 'ABCD-EFGH', verifyUrl: 'https://commonly.me/cli/authorize',
      stdin: new EventEmitter(), wait: async () => undefined, now: () => 1,
    })).rejects.toBeInstanceOf(DeviceLoginDeniedError);

    const expired = { post: jest.fn().mockResolvedValue({ status: 'expired' }) };
    await expect(waitForDeviceAuthorization({
      client: expired,
      deviceCode: 'secret-device-code', userCode: 'ABCD-EFGH', verifyUrl: 'https://commonly.me/cli/authorize',
      stdin: new EventEmitter(), wait: async () => undefined, now: () => 1,
    })).rejects.toBeInstanceOf(DeviceLoginExpiredError);
  });

  test('whoami differentiates a no-expiry device token from an expired JWT', () => {
    expect(formatTokenStatus('cm_device', 'device', 0)).toBe('device token · no expiry');
    const expiredJwt = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`;
    expect(formatTokenStatus(expiredJwt, 'jwt', 1001, 'dev')).toBe('expired — commonly login --instance dev');
  });
});
