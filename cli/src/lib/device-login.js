/**
 * RFC 8628-shaped device-code interaction for `commonly login`.
 *
 * The browser owns password/OAuth; the terminal only ever receives the
 * resulting per-device bearer once from /device/poll. This module keeps the
 * timing and terminal-key behaviour testable without a live TTY.
 */
import { execFile as nodeExecFile } from 'child_process';
import { platform } from 'os';
import { emitKeypressEvents } from 'readline';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeviceLoginCancelledError extends Error {
  constructor() {
    super('Login cancelled.');
    this.name = 'DeviceLoginCancelledError';
  }
}

export const openBrowser = (url, execFile = nodeExecFile, currentPlatform = platform()) => {
  const command = currentPlatform === 'darwin' ? 'open' : currentPlatform === 'win32' ? 'cmd' : 'xdg-open';
  const args = currentPlatform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    execFile(command, args, () => resolve());
  });
};

export const waitForDeviceAuthorization = async ({
  client,
  deviceCode,
  userCode,
  verifyUrl,
  interval = 5,
  expiresIn = 600,
  stdin = process.stdin,
  wait = sleep,
  onOpen = openBrowser,
  onStatus = () => undefined,
  now = () => Date.now(),
}) => {
  const authorizeUrl = `${verifyUrl}?code=${encodeURIComponent(userCode)}`;
  let cancelled = false;
  let signalCancellation = () => {};
  const cancellation = new Promise((resolve) => {
    signalCancellation = resolve;
  });
  let currentInterval = Math.max(Number(interval) || 5, 1);
  const deadline = now() + Math.max(Number(expiresIn) || 600, 1) * 1000;
  const isTty = Boolean(stdin?.isTTY && typeof stdin.setRawMode === 'function');

  const onKeypress = (value, key = {}) => {
    if (key?.ctrl && key.name === 'c') {
      cancelled = true;
      signalCancellation();
    }
    if (value === 'q') {
      cancelled = true;
      signalCancellation();
    }
    if (value === 'o') void onOpen(authorizeUrl);
  };

  if (stdin?.on) {
    emitKeypressEvents(stdin);
    if (isTty) stdin.setRawMode(true);
    stdin.on('keypress', onKeypress);
  }

  try {
    while (now() < deadline) {
      if (cancelled) throw new DeviceLoginCancelledError();
      let result;
      try {
        result = await client.post('/api/auth/device/poll', { deviceCode });
      } catch {
        throw new Error('Unable to complete device authorization. Try again.');
      }
      if (result?.status === 'authorized' && result.token) return result;
      if (result?.status === 'denied') throw new Error('Authorization was denied in your browser.');
      if (result?.status === 'expired') throw new Error('Authorization code expired. Run commonly login again.');
      if (result?.status === 'slow_down') {
        currentInterval *= 2;
        onStatus('Waiting for browser approval (slowing down)…');
      } else if (result?.status !== 'authorization_pending') {
        throw new Error('Authorization code expired. Run commonly login again.');
      }
      await Promise.race([
        wait(currentInterval * 1000),
        cancellation,
      ]);
    }
    throw new Error('Authorization code expired. Run commonly login again.');
  } finally {
    if (stdin?.removeListener) stdin.removeListener('keypress', onKeypress);
    if (isTty) stdin.setRawMode(false);
  }
};
