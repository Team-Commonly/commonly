import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';

/**
 * Does Claude's credential read survive the removal of the system Keychains
 * folder from the baseline? Claude reads its OAuth item by running
 * /usr/bin/security, whose default search list includes System.keychain.
 * If Security.framework treats a denied search-list keychain as fatal, every
 * public Claude seat would fail to log in after the change ships (TASK-233,
 * Otto's Ask 2 on eca2d8d79).
 *
 * This writes a probe item into the login keychain, so it runs only when the
 * disposable macOS job sets COMMONLY_KEYCHAIN_PROBE=1. It never runs on an
 * operator host.
 */
const probeEnabled = process.platform === 'darwin' && process.env.COMMONLY_KEYCHAIN_PROBE === '1';
const macProbe = probeEnabled ? test : test.skip;

const SERVICE = 'commonly-seatbelt-probe';
const loginKeychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
const secret = randomBytes(16).toString('hex');
const root = probeEnabled ? mkdtempSync(join(tmpdir(), 'commonly-keychain-probe-')) : null;
const workspace = root && join(root, 'workspace');
const state = root && join(root, 'state');
if (root) {
  mkdirSync(workspace);
  mkdirSync(state);
}

beforeAll(() => {
  if (!probeEnabled) return;
  const added = spawnSync('/usr/bin/security', [
    'add-generic-password', '-U', '-s', SERVICE, '-a', 'commonly', '-w', secret, loginKeychain,
  ], { encoding: 'utf8' });
  if (added.status !== 0) throw new Error(`could not write the probe item: ${added.stderr}`);
});

afterAll(() => {
  if (!probeEnabled) return;
  spawnSync('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, loginKeychain], { encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
});

// A confined Node spawns security, as the Claude CLI does. The profile is the
// Claude runtime profile, or that profile plus one extra rule for a control.
const readProbe = (extraRules = '') => {
  const profile = `${buildSeatbeltProfile({
    workspacePath: workspace, executablePath: process.execPath, statePath: state, allowClaudeRuntimeAccess: true,
  })}\n${extraRules}`;
  return spawnSync('/usr/bin/sandbox-exec', [
    '-p', profile, process.execPath, '-e',
    `const { spawnSync } = require('child_process');
     const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', '${SERVICE}', '-w'], { encoding: 'utf8' });
     process.stdout.write(String(r.stdout).trim()); process.stderr.write(String(r.stderr).trim()); process.exitCode = r.status;`,
  ], { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
};

macProbe('the probe item is readable outside any sandbox (precondition)', () => {
  const result = spawnSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w'], { encoding: 'utf8' });
  expect({ status: result.status, stdout: result.stdout.trim() }).toEqual({ status: 0, stdout: secret });
});

macProbe('the Claude runtime profile still reads its credential with System.keychain denied', () => {
  const result = readProbe();
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 0, stdout: secret, stderr: '',
  });
});

macProbe('control: the old broad Keychains folder grant also reads it', () => {
  const result = readProbe('(allow file-read* (subpath "/Library/Keychains"))');
  expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 0, stdout: secret });
});
