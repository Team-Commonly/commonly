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
import { sandboxRunArgv, startRunEgress } from '../src/valet/sandbox.js';
import { wrapArgvWithBwrap } from '../src/sandbox/bwrap.js';
import { LOOPBACK_BRIDGE } from '../src/sandbox/loopback.js';
import { RunFailure } from '../src/failures.js';

const REAL_HOME = homedir();
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
before(() => Object.defineProperty(process, 'platform', { value: 'linux' }));
after(() => Object.defineProperty(process, 'platform', platform));

const bwrapHere = { bwrap: () => ({ available: true, path: 'bwrap' }) };
const withRun = async (fn, { grant = {}, provider } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-sandbox-linux-'));
  const run = await prepareRunEnv({ grant, baseEnv: { HOME: REAL_HOME }, root });
  const egress = await startRunEgress({ run, platform: 'linux', provider });
  try { return await fn(run, egress); } finally {
    await egress.close();
    await run.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
};
/** The argv bwrap runs after `--`: the bridge, its two slots, then the CLI. */
const inner = (argv) => argv.slice(argv.indexOf('--') + 1);
/** [flag, ...operands] for each mount, so a test reads intent, not positions. */
const mounts = (argv) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (['--bind', '--ro-bind', '--bind-try', '--ro-bind-try'].includes(argv[i])) out.push(argv.slice(i, i + 3));
  }
  return out;
};

test('bwrap binds the run HOME read-write, sets HOME to it, and never mounts the real HOME', () => withRun(async (run, egress) => {
  const { argv, sandbox } = sandboxRunArgv({ argv: ['/usr/bin/node', '-e', '1'], run, egress, platform: 'linux', detect: bwrapHere });
  assert.equal(sandbox, 'bwrap');
  assert.equal(argv[0], 'bwrap');
  assert.deepEqual(inner(argv).slice(-3), ['/usr/bin/node', '-e', '1']);
  for (const flag of ['--unshare-all', '--unshare-net', '--die-with-parent', '--new-session']) assert.ok(argv.includes(flag), flag);
  assert.ok(!argv.includes('--share-net'));
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

test('a read workspace mounts read-only, and the run HOME stays the one writable mount', () => withRun(async (run, egress) => {
  const ws = mkdtempSync(join(tmpdir(), 'seats-ws-'));
  try {
    const { argv } = sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress, platform: 'linux', detect: bwrapHere, workspace: { path: ws } });
    const binds = mounts(argv);
    assert.deepEqual(binds.filter(([flag]) => flag === '--bind' || flag === '--bind-try'), [['--bind-try', run.home, run.home]]);
    assert.ok(binds.some((m) => m.join(' ') === `--ro-bind ${ws} ${ws}`));
    assert.deepEqual(argv.slice(argv.indexOf('--chdir'), argv.indexOf('--chdir') + 2), ['--chdir', ws]);
    const write = sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress, platform: 'linux', detect: bwrapHere, workspace: { path: ws, access: 'write' } });
    assert.ok(mounts(write.argv).some((m) => m.join(' ') === `--bind ${ws} ${ws}`));
  } finally { rmSync(ws, { recursive: true, force: true }); }
}));

test('on Linux a workspace holding the real HOME is refused', () => withRun(async (run, egress) => {
  assert.throws(
    () => sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress, platform: 'linux', detect: bwrapHere, workspace: { path: REAL_HOME } }),
    /may not hold the real HOME/,
  );
}));

test('bwrap missing or refused is unsupported, or none when accepted', () => withRun(async (run, egress) => {
  const refused = { bwrap: () => ({ available: false, error: 'bubblewrap is installed but cannot start a sandbox on this machine' }) };
  assert.throws(
    () => sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress, platform: 'linux', detect: refused }),
    (error) => error instanceof RunFailure && error.kind === 'unsupported' && /cannot start a sandbox/.test(error.message),
  );
  const accepted = sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress, platform: 'linux', detect: refused, require: false });
  assert.equal(accepted.sandbox, 'none');
  assert.equal(accepted.egress, 'none');
  assert.deepEqual(accepted.argv, ['/usr/bin/true']);
  assert.equal(accepted.env.HTTPS_PROXY, undefined, 'no proxy route without the namespace that makes it the only one');
}));

test('egress on Linux: an isolated namespace whose one route is the bridge to the proxy socket', () => withRun(async (run, egress) => {
  assert.equal(egress.port, null);
  assert.match(egress.socketPath, /seat-egress-[^/]+\/egress\.sock$/);
  const { argv, env } = sandboxRunArgv({ argv: ['/opt/cli/agent', '--x'], run, egress, platform: 'linux', detect: bwrapHere });
  for (const flag of ['--unshare-net', '--cap-add']) assert.ok(argv.includes(flag), flag);
  assert.deepEqual(argv.slice(argv.indexOf('--uid'), argv.indexOf('--uid') + 4), ['--uid', '0', '--gid', '0']);
  assert.deepEqual(inner(argv), [
    process.execPath, LOOPBACK_BRIDGE, egress.socketPath, '8765', '-', '8766', '/opt/cli/agent', '--x',
  ]);
  const ro = mounts(argv).filter(([flag]) => flag === '--ro-bind').map(([, src]) => src);
  for (const path of ['/opt/cli/agent', process.execPath, LOOPBACK_BRIDGE, egress.socketDir]) assert.ok(ro.includes(path), path);
  assert.ok(mounts(argv).some((m) => m.join(' ') === '--ro-bind-try /usr/sbin /usr/sbin'), 'iproute2 for the bridge');
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
    assert.equal(env[name], 'http://127.0.0.1:8765', name);
  }
  assert.equal(env.NO_PROXY, undefined);
  assert.ok(!argv.some((arg) => arg.includes('PROXY')), 'the route rides the env, not argv');
}));

test('egress on Linux: a loopback provider gets the bridge\'s second slot, relayed to its fixed origin', () => withRun(async (run, egress) => {
  assert.match(egress.relaySocketPath, /provider\.sock$/);
  const { argv, env } = sandboxRunArgv({ argv: ['/opt/cli/agent'], run, egress, platform: 'linux', detect: bwrapHere });
  assert.deepEqual(inner(argv).slice(2, 6), [egress.socketPath, '8766', egress.relaySocketPath, '8765']);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:8766', 'the proxy moves off the port the provider holds');
  assert.equal(env.NO_PROXY, '127.0.0.1');
  assert.deepEqual(egress.allow, [], 'a loopback provider is reached directly, never through the proxy');
}, { provider: { baseURL: 'http://127.0.0.1:8765/v1' } }));

test('egress on Linux: a hosted provider joins the allowlist as one exact entry', () => withRun(async (run, egress) => {
  assert.deepEqual(egress.allow, ['*.example.com:443', 'api.provider.test:443']);
  const { env } = sandboxRunArgv({ argv: ['/opt/cli/agent'], run, egress, platform: 'linux', detect: bwrapHere });
  assert.equal(env.NO_PROXY, undefined);
}, { grant: { network: { allow: ['*.example.com:443'] } }, provider: { baseURL: 'https://API.provider.test/v1' } }));

test('the bwrap builder keeps its old argv when workspaceAccess takes its default', () => {
  const opts = { workspacePath: '/w', homePath: '/h' };
  assert.deepEqual(wrapArgvWithBwrap(['x'], {}, { ...opts, workspaceAccess: 'write' }), wrapArgvWithBwrap(['x'], {}, opts));
  assert.throws(() => wrapArgvWithBwrap(['x'], {}, { ...opts, workspaceAccess: 'none' }), /must be read or write/);
});
