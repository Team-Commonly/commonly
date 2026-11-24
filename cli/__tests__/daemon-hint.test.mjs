import { foregroundDaemonHint } from '../src/lib/daemon-hint.js';

// The foreground hint must tell the truth for both states: with no daemon, the
// full add-this-computer path; with one, only the placement step. Neither may
// promise a reboot, and the run path itself is not in this test.
test('with no daemon registered, the hint names register, install, then the web placement', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: false });
  expect(hint).toContain('commonly daemon register && commonly daemon install');
  expect(hint).toContain('Agents → Bring your own → On my computer');
  expect(hint).not.toMatch(/reboot|restart|log ?in/i);
});

// F570: run through npx (the Bring your own page's line), `daemon install`
// would pin the service to npx's evictable cache, so the hint names the setup
// line, which installs a stable copy first, and never `daemon install`.
const NPX_ENTRY = '/Users/a/.npm/_npx/0123abcd/node_modules/@commonlyai/cli/src/index.js';
const NPX_ENTRY_WIN = 'C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\0123abcd\\node_modules\\@commonlyai\\cli\\src\\index.js';

test('run from npx with no daemon, the hint names daemon setup for this instance, never daemon install', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: false, platform: 'darwin', entry: NPX_ENTRY, instanceUrl: 'https://api.commonly.me' });
  expect(hint).toContain('add this computer once with: npx -y @commonlyai/cli@latest daemon setup --instance https://api.commonly.me\n');
  expect(hint).toContain('Agents → Bring your own → On my computer');
  expect(hint).not.toMatch(/daemon (install|register)|--unsandboxed/);
});

test('run from npx on Windows, the setup line uses npx.cmd and carries --unsandboxed', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: false, platform: 'win32', entry: NPX_ENTRY_WIN, instanceUrl: 'https://api.commonly.me' });
  expect(hint).toContain('npx.cmd -y @commonlyai/cli@latest daemon setup --instance https://api.commonly.me --unsandboxed');
  expect(hint).not.toMatch(/daemon (install|register)/);
});

test('run from npx with a daemon registered, the hint is still only the placement step', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: true, entry: NPX_ENTRY });
  expect(hint).toContain('add the agent to this computer in the web app');
  expect(hint).not.toMatch(/daemon (setup|install)/);
});

test('with a daemon registered, the hint names only the placement step', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: true });
  expect(hint).toContain('add the agent to this computer in the web app');
  expect(hint).toContain('Agents → Bring your own → On my computer');
  expect(hint).not.toContain('commonly daemon');
  expect(hint).not.toMatch(/reboot|restart|log ?in/i);
});
