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

test('replaces a server token message with an actionable saved-profile instruction', async () => {
  saveInstance({
    key: 'dev', url: 'https://api.commonly.me', token: 'stale-token', userId: 'u1', username: 'lily',
  });
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ msg: 'Token is not valid' }),
  });

  await expect(createClient({ instance: 'dev' }).get('/api/auth/user')).rejects.toThrow(
    'Session for dev (https://api.commonly.me) has expired.\nRun: commonly login --instance dev',
  );
});
