import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
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
}
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

// Two profiles reach the Keychain, and only the Claude one passes this flag.
// The denial must hold under both, or a grant added to claudeRuntimeRules
// would go unnoticed (TASK-233, Otto's mutation on eca2d8d79).
const PROFILES = [
  { label: 'public', options: {} },
  { label: 'Claude runtime', options: { allowClaudeRuntimeAccess: true } },
];

const run = (code, options = {}) => spawnSync('/usr/bin/sandbox-exec', [
  '-p', buildSeatbeltProfile({
    workspacePath: workspace, executablePath: process.execPath, statePath: state, ...options,
  }), process.execPath, '-e', code,
], {
  cwd: workspace, encoding: 'utf8', timeout: 15_000,
});

describe.each(PROFILES)('$label Seatbelt', ({ options }) => {
  macTest('denies listing and opening system Keychains', () => {
    const result = run(`const fs = require('fs');
      for (const path of ['/Library/Keychains', '/Library/Keychains/System.keychain',
        '/Library/Keychains/apsd.keychain']) {
        try {
          if (path.endsWith('/Keychains')) fs.readdirSync(path);
          else fs.closeSync(fs.openSync(path, 'r'));
          console.log('ALLOWED');
        } catch (error) { console.log(error.code); }
      }`, options);
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout.trim().split('\n')).toEqual(['EPERM', 'EPERM', 'EPERM']);
  });

  // Node reads this file at startup with no OPENSSL_CONF override, so the
  // literal grant in PLATFORM_BASELINE must let the read through (TASK-233).
  macTest('reads the system OpenSSL config that Node loads at startup', () => {
    const result = run(`const fs = require('fs');
      try { fs.readFileSync('/System/Library/OpenSSL/openssl.cnf'); console.log('READ'); }
      catch (error) { console.log(error.code); }`, options);
    expect(result.error).toBeUndefined();
    expect(result.stdout.trim()).toBe('READ');
  });
});

macTest('Node can complete HTTPS with the system Keychains folder denied', () => {
  const result = run(`fetch('https://example.com')
    .then((response) => { console.log(response.status); })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });`);
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stdout: result.stdout.trim(), stderr: result.stderr })
    .toEqual({ status: 0, stdout: '200', stderr: '' });
});
