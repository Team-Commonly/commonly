/**
 * One `security list-keychains`, inside the composed sandbox, to show the
 * keychain is out of reach at runtime and not only in the profile text.
 *
 * Off by default. A host's securityd has wedged machine-wide after repeated
 * keychain experiments, so this runs only when SEATS_KEYCHAIN_PROBE=1, once,
 * under a 10 s timeout. It never loops, never runs `security` outside the
 * sandbox, and uses no subcommand that reads an item or edits an ACL. The
 * profile-text check in valet-sandbox.test.js runs every time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareRunEnv } from '../src/valet/env.js';
import { sandboxRunArgv, startRunEgress } from '../src/valet/sandbox.js';

const enabled = process.platform === 'darwin' && process.env.SEATS_KEYCHAIN_PROBE === '1';

test('one list-keychains inside the sandbox reaches no real keychain', {
  skip: enabled ? false : 'set SEATS_KEYCHAIN_PROBE=1 on macOS to run it, once',
}, async (t) => {
  const run = await prepareRunEnv({ grant: {}, baseEnv: { ...process.env, HOME: homedir() } });
  const egress = await startRunEgress({ run });
  try {
    const { argv, env, sandbox } = sandboxRunArgv({ argv: ['/usr/bin/security', 'list-keychains'], run, egress });
    // The guard against ever running it bare.
    assert.equal(sandbox, 'seatbelt');
    assert.equal(argv[0], '/usr/bin/sandbox-exec');
    const result = spawnSync(argv[0], argv.slice(1), { env, cwd: run.home, encoding: 'utf8', timeout: 10_000 });
    t.diagnostic(JSON.stringify({
      status: result.status, signal: result.signal, error: result.error?.code || null,
      stdout: result.stdout, stderr: result.stderr,
    }));
    assert.equal(result.error, undefined, 'security returned inside the timeout');
    assert.ok(!`${result.stdout}${result.stderr}`.includes(join(homedir(), 'Library', 'Keychains')), 'no real keychain path came back');
  } finally {
    await egress.close();
    await run.cleanup();
  }
});
