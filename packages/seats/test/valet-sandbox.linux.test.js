/**
 * Linux composition, argv shape only. Not walked on Linux: no Linux host ran
 * these argvs under a real bwrap. wrapArgvWithBwrap refuses off Linux, so the
 * file runs with process.platform reading 'linux' (node --test gives each
 * file its own process).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunEnv } from '../src/valet/env.js';
import { sandboxRunArgv } from '../src/valet/sandbox.js';
import { wrapArgvWithBwrap } from '../src/sandbox/bwrap.js';
import { RunFailure } from '../src/failures.js';

const REAL_HOME = homedir();
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
before(() => Object.defineProperty(process, 'platform', { value: 'linux' }));
after(() => Object.defineProperty(process, 'platform', platform));

const bwrapHere = { bwrap: () => ({ available: true, path: 'bwrap' }) };
const withRun = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-sandbox-linux-'));
  const run = await prepareRunEnv({ grant: {}, baseEnv: { HOME: REAL_HOME }, root });
  try { return await fn(run); } finally { await run.cleanup(); rmSync(root, { recursive: true, force: true }); }
};
/** [flag, ...operands] for each mount, so a test reads intent, not positions. */
const mounts = (argv) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (['--bind', '--ro-bind', '--bind-try', '--ro-bind-try'].includes(argv[i])) out.push(argv.slice(i, i + 3));
  }
  return out;
};

test('bwrap binds the run HOME read-write, sets HOME to it, and never mounts the real HOME', () => withRun(async (run) => {
  const { argv, sandbox } = sandboxRunArgv({ argv: ['/usr/bin/node', '-e', '1'], run, platform: 'linux', detect: bwrapHere });
  assert.equal(sandbox, 'bwrap');
  assert.equal(argv[0], 'bwrap');
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['/usr/bin/node', '-e', '1']);
  for (const flag of ['--unshare-all', '--share-net', '--die-with-parent', '--new-session']) assert.ok(argv.includes(flag), flag);
  const binds = mounts(argv);
  assert.deepEqual(binds.filter(([flag]) => flag === '--bind' || flag === '--bind-try'), [['--bind', run.home, run.home]]);
  assert.ok(binds.some((m) => m.join(' ') === `--ro-bind /usr/bin/node /usr/bin/node`), 'the CLI is mounted read-only');
  assert.deepEqual(argv.slice(argv.indexOf('--chdir'), argv.indexOf('--chdir') + 2), ['--chdir', run.home]);
  assert.deepEqual(argv.slice(argv.indexOf('HOME') - 1, argv.indexOf('HOME') + 2), ['--setenv', 'HOME', run.home]);
  // Nothing at or under the real HOME is mounted, and no env value rides argv.
  const mounted = binds.flatMap(([, src, dest]) => [src, dest]);
  assert.deepEqual(mounted.filter((path) => path === REAL_HOME || path.startsWith(`${REAL_HOME}/`)), []);
  assert.ok(!argv.some((arg) => arg.startsWith(REAL_HOME)));
}));

test('a read workspace mounts read-only, and the run HOME stays the one writable mount', () => withRun(async (run) => {
  const ws = mkdtempSync(join(tmpdir(), 'seats-ws-'));
  try {
    const { argv } = sandboxRunArgv({ argv: ['/usr/bin/true'], run, platform: 'linux', detect: bwrapHere, workspace: { path: ws } });
    const binds = mounts(argv);
    assert.deepEqual(binds.filter(([flag]) => flag === '--bind' || flag === '--bind-try'), [['--bind-try', run.home, run.home]]);
    assert.ok(binds.some((m) => m.join(' ') === `--ro-bind ${ws} ${ws}`));
    assert.deepEqual(argv.slice(argv.indexOf('--chdir'), argv.indexOf('--chdir') + 2), ['--chdir', ws]);
    const write = sandboxRunArgv({ argv: ['/usr/bin/true'], run, platform: 'linux', detect: bwrapHere, workspace: { path: ws, access: 'write' } });
    assert.ok(mounts(write.argv).some((m) => m.join(' ') === `--bind ${ws} ${ws}`));
  } finally { rmSync(ws, { recursive: true, force: true }); }
}));

test('on Linux a workspace holding the real HOME is refused', () => withRun(async (run) => {
  assert.throws(
    () => sandboxRunArgv({ argv: ['/usr/bin/true'], run, platform: 'linux', detect: bwrapHere, workspace: { path: REAL_HOME } }),
    /may not hold the real HOME/,
  );
}));

test('bwrap missing or refused is unsupported, or none when accepted', () => withRun(async (run) => {
  const refused = { bwrap: () => ({ available: false, error: 'bubblewrap is installed but cannot start a sandbox on this machine' }) };
  assert.throws(
    () => sandboxRunArgv({ argv: ['/usr/bin/true'], run, platform: 'linux', detect: refused }),
    (error) => error instanceof RunFailure && error.kind === 'unsupported' && /cannot start a sandbox/.test(error.message),
  );
  const accepted = sandboxRunArgv({ argv: ['/usr/bin/true'], run, platform: 'linux', detect: refused, require: false });
  assert.equal(accepted.sandbox, 'none');
  assert.deepEqual(accepted.argv, ['/usr/bin/true']);
}));

test('the bwrap builder keeps its old argv when workspaceAccess takes its default', () => {
  const opts = { workspacePath: '/w', homePath: '/h' };
  assert.deepEqual(wrapArgvWithBwrap(['x'], {}, { ...opts, workspaceAccess: 'write' }), wrapArgvWithBwrap(['x'], {}, opts));
  assert.throws(() => wrapArgvWithBwrap(['x'], {}, { ...opts, workspaceAccess: 'none' }), /must be read or write/);
});
