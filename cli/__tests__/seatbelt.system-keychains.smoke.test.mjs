import { spawn, spawnSync } from 'child_process';
import { createServer } from 'https';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'fs';
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

// Measure the narrow literal against a real Seatbelt profile before the
// production baseline changes. Do not install a root on an operator machine.
const narrowedProfile = () => buildSeatbeltProfile({
  workspacePath: workspace, executablePath: process.execPath, statePath: state,
}).replace('  (subpath "/Library/Keychains")\n',
  '  (literal "/Library/Keychains/System.keychain")\n');

macTest('narrowed profile refuses system Keychains listing and legacy file opens', () => {
  const code = `const fs = require('fs');
    const paths = ['/Library/Keychains', '/Library/Keychains/System.keychain',
      '/Library/Keychains/apsd.keychain'];
    for (const path of paths) {
      try {
        if (path.endsWith('/Keychains')) fs.readdirSync(path);
        else fs.closeSync(fs.openSync(path, 'r'));
        console.log('ALLOWED');
      } catch (error) { console.log(error.code); }
    }`;
  const result = spawnSync('/usr/bin/sandbox-exec', [
    '-p', narrowedProfile(), process.execPath, '-e', code,
  ], {
    cwd: workspace, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, OPENSSL_CONF: join(workspace, 'openssl.cnf') },
  });
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout.trim().split('\n')).toEqual(['EPERM', 'ALLOWED', 'EPERM']);
});

const disposableRunnerTest = process.platform === 'darwin'
  && process.env.COMMONLY_DISPOSABLE_SYSTEM_ROOT_CERT
  && process.env.COMMONLY_DISPOSABLE_SYSTEM_ROOT_KEY ? test : test.skip;

disposableRunnerTest('system-trusted local TLS still works without direct Keychains reads', async () => {
  const certificate = readFileSync(process.env.COMMONLY_DISPOSABLE_SYSTEM_ROOT_CERT);
  const key = readFileSync(process.env.COMMONLY_DISPOSABLE_SYSTEM_ROOT_KEY);
  const server = createServer({ cert: certificate, key }, (_req, response) => response.end('tls-ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const curlArgs = ['--fail', '--silent', '--show-error', `https://127.0.0.1:${port}/`];
    const control = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/curl', curlArgs);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    expect(control).toEqual({ status: 0, stdout: 'tls-ok', stderr: '' });
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', [
        '-p', narrowedProfile(), '/usr/bin/curl', ...curlArgs,
      ], { cwd: workspace });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    expect(result).toEqual({ status: 0, stdout: 'tls-ok', stderr: '' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}, 15_000);
