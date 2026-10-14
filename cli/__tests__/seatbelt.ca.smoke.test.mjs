import { spawnSync } from 'child_process';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const caBundle = '/opt/homebrew/etc/openssl@3/cert.pem';
const homebrewCaAvailable = process.platform === 'darwin' && existsSync(caBundle);
const macTest = homebrewCaAvailable ? test : test.skip;

macTest('a sandboxed Node bin under HOME can fetch TLS using the Homebrew CA bundle', () => {
  const root = mkdtempSync(join(homedir(), '.commonly-ca-seatbelt-'));
  try {
    const workspace = join(root, 'workspace');
    const state = join(root, 'state');
    const binDir = join(root, 'bin');
    for (const path of [workspace, state, binDir]) mkdirSync(path);
    const bin = join(binDir, 'node');
    symlinkSync(process.execPath, bin);

    const argv = wrapArgvWithSeatbelt([
      bin,
      '-e',
      `const https = require('https');
       const fs = require('fs');
       const ca = fs.readFileSync(process.env.SSL_CERT_FILE);
       https.get('https://example.com', { ca, timeout: 8000 }, (response) => {
         response.resume();
         response.on('end', () => {
           if (response.statusCode !== 200) process.exitCode = 1;
           else process.stdout.write('tls-ok');
         });
       }).on('error', (error) => {
         process.stderr.write(error.message);
         process.exitCode = 1;
       });`,
    ], {
      workspacePath: workspace,
      executablePath: bin,
      statePath: state,
    });
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 12000,
      env: { ...process.env, SSL_CERT_FILE: caBundle, NODE_OPTIONS: '' },
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('tls-ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
