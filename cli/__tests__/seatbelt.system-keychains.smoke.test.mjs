import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;
const root = process.platform === 'darwin'
  ? mkdtempSync(join(homedir(), '.commonly-keychain-smoke-')) : null;
const workspace = root && join(root, 'workspace');
const state = root && join(root, 'state');
if (root) {
  mkdirSync(workspace);
  mkdirSync(state);
  writeFileSync(join(workspace, 'openssl.cnf'), '');
}
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const run = (code) => spawnSync('/usr/bin/sandbox-exec', [
  '-p', buildSeatbeltProfile({
    workspacePath: workspace, executablePath: process.execPath, statePath: state,
  }), process.execPath, '-e', code,
], {
  cwd: workspace, encoding: 'utf8', timeout: 15_000,
  env: { ...process.env, OPENSSL_CONF: join(workspace, 'openssl.cnf') },
});

macTest('public Seatbelt denies listing and opening system Keychains', () => {
  const result = run(`const fs = require('fs');
    for (const path of ['/Library/Keychains', '/Library/Keychains/System.keychain',
      '/Library/Keychains/apsd.keychain']) {
      try {
        if (path.endsWith('/Keychains')) fs.readdirSync(path);
        else fs.closeSync(fs.openSync(path, 'r'));
        console.log('ALLOWED');
      } catch (error) { console.log(error.code); }
    }`);
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout.trim().split('\n')).toEqual(['EPERM', 'EPERM', 'EPERM']);
});

macTest('Node can complete HTTPS with the system Keychains folder denied', () => {
  const result = run(`fetch('https://example.com')
    .then((response) => { console.log(response.status); })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });`);
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stdout: result.stdout.trim(), stderr: result.stderr })
    .toEqual({ status: 0, stdout: '200', stderr: '' });
});
