import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const DEFAULTS = '/usr/bin/defaults';
const macTest = process.platform === 'darwin' ? test : test.skip;

const run = (argv, cwd) => spawnSync(argv[0], argv.slice(1), {
  cwd,
  encoding: 'utf8',
  timeout: 15_000,
});

macTest('a confined process cannot read another app\'s preference domain', () => {
  // A synthetic domain stands in for any app's domain: it lives in
  // ~/Library/Preferences like every other, and the test owns its contents.
  const domain = `com.commonly.seatbelt-probe.${randomUUID()}`;
  const canary = `PREFERENCE_CANARY_${randomUUID()}`;
  const plist = join(homedir(), 'Library', 'Preferences', `${domain}.plist`);
  // Real seats keep their state under HOME, so the profile admits HOME's
  // metadata. A tmpdir root would deny that too, and `defaults` would then
  // fail for every domain, which would make the denial below vacuous.
  const root = mkdtempSync(join(homedir(), '.commonly-prefs-seatbelt-'));
  const workspace = join(root, 'workspace');
  const state = join(root, 'state');
  mkdirSync(workspace);
  mkdirSync(state);
  const confined = (args) => run(wrapArgvWithSeatbelt([DEFAULTS, ...args], {
    workspacePath: workspace,
    executablePath: DEFAULTS,
    statePath: state,
  }), workspace);

  try {
    const write = run([DEFAULTS, 'write', domain, 'canary', '-string', canary], workspace);
    expect(write.status).toBe(0);
    // Positive control: the domain is readable outside the sandbox.
    expect(run([DEFAULTS, 'read', domain, 'canary'], workspace).stdout.trim()).toBe(canary);

    for (const target of [domain, plist]) {
      const denied = confined(['read', target]);
      expect(denied.status).not.toBe(0);
      expect(`${denied.stdout}${denied.stderr}`).not.toContain(canary);
      expect(denied.stderr).toMatch(/does not exist/);
    }

    // Positive control: the admitted global domain still reads inside the
    // sandbox, so the denial above is the domain filter, not a broken spawn.
    const global = confined(['read', '-g']);
    expect(global.status).toBe(0);
    expect(global.stdout.trim().startsWith('{')).toBe(true);
  } finally {
    run([DEFAULTS, 'delete', domain], workspace);
    rmSync(plist, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
