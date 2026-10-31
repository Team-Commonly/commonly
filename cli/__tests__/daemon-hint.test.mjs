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

test('with a daemon registered, the hint names only the placement step', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: true });
  expect(hint).toContain('add the agent to this computer in the web app');
  expect(hint).toContain('Agents → Bring your own → On my computer');
  expect(hint).not.toContain('commonly daemon');
  expect(hint).not.toMatch(/reboot|restart|log ?in/i);
});
