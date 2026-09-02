import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-api-expiry-'));
await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => configTmpDir },
  homedir: () => configTmpDir,
}));

const { saveInstance } = await import('../src/lib/config.js');
const { createClient } = await import('../src/lib/api.js');

afterAll(() => fs.rmSync(path.join(configTmpDir, '.commonly'), { recursive: true, force: true }));

test.each(['Token is not valid', 'Invalid API token', 'Account no longer exists'])(
  'replaces %s with an actionable saved-profile instruction',
  async (serverMessage) => {
  saveInstance({
    key: 'dev', url: 'https://api.commonly.me', token: 'stale-token', userId: 'u1', username: 'lily',
  });
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ msg: serverMessage }),
  });

  await expect(createClient({ instance: 'dev' }).get('/api/auth/user')).rejects.toThrow(
    'Session for dev (https://api.commonly.me) has expired.\nRun: commonly login --instance dev',
  );
  },
);

test('DELETE forwards an explicit body through the profile-aware client', async () => {
  saveInstance({
    key: 'dev', url: 'https://api.commonly.me', token: 'current-token', userId: 'u1', username: 'lily',
  });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ released: true }),
  });

  await expect(createClient({ instance: 'dev' }).del('/api/claims/message-1', { outcome: 'declined' }))
    .resolves.toEqual({ released: true });

  const [url, init] = global.fetch.mock.calls[0];
  expect(url).toBe('https://api.commonly.me/api/claims/message-1');
  expect(init).toMatchObject({
    method: 'DELETE',
    headers: { Authorization: 'Bearer current-token', 'Content-Type': 'application/json' },
  });
  expect(JSON.parse(init.body)).toEqual({ outcome: 'declined' });
});
