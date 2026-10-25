import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunEnv } from '../src/valet/env.js';
import { sandboxRunArgv, startRunEgress, REAL_HOME_LOGIN_PATHS } from '../src/valet/sandbox.js';
import { buildSeatbeltProfile } from '../src/sandbox/seatbelt.js';
import { RunFailure } from '../src/failures.js';

const REAL_HOME = homedir();
const GRANTED = 'sk-granted-0123456789abcdef';
const WITHHELD = 'sk-withheld-fedcba9876543210';
const onMac = process.platform === 'darwin';
const macTest = onMac ? test : test.skip;

const recorder = () => { const events = []; return { events, emit: (type, data) => events.push({ type, data }) }; };
// Each run gets its egress handle; sandboxRunArgv refuses a run without one.
const withRun = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-sandbox-'));
  const run = await prepareRunEnv({
    grant: { credentials: [{ name: 'OPENAI_API_KEY', from: 'env' }] },
    baseEnv: { ...process.env, HOME: REAL_HOME, OPENAI_API_KEY: GRANTED, ANTHROPIC_API_KEY: WITHHELD },
    root,
  });
  const handles = [];
  const egressFor = async (forRun = run, platform = process.platform) => {
    const egress = await startRunEgress({ run: forRun, platform });
    handles.push(egress);
    return egress;
  };
  run.egress = await egressFor();
  try { return await fn(run, root, egressFor); } finally {
    for (const egress of handles) await egress.close();
    await run.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
};

// Positive controls: a denial only means something if the target exists.
const requireOnHost = (...parts) => {
  const path = join(REAL_HOME, ...parts);
  if (!existsSync(path)) assert.fail(`positive control missing on this host: ${path}`);
  return path;
};

// The child tries each operation by absolute path and reports only an error
// code or OK, never file contents. argv: <real home> <outside dir>.
const PROBE = `
const fs = require('fs'); const os = require('os'); const path = require('path');
const [realHome, outside] = process.argv.slice(1);
const attempt = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code || e.message; } };
const write = (dir) => attempt(() => { const f = path.join(dir, 'probe-' + process.pid); fs.writeFileSync(f, 'x'); fs.rmSync(f); });
process.stdout.write(JSON.stringify({
  key: process.env.OPENAI_API_KEY || null,
  withheld: process.env.ANTHROPIC_API_KEY || null,
  homedir: os.homedir(),
  writeHome: write(os.homedir()),
  writeTmp: write(os.tmpdir()),
  writeOutside: write(outside),
  writeRealHome: write(realHome),
  writeSharedTmp: write('/private/tmp'),
  listRealHome: attempt(() => fs.readdirSync(realHome)),
  listClaude: attempt(() => fs.readdirSync(path.join(realHome, '.claude'))),
  statClaude: attempt(() => fs.statSync(path.join(realHome, '.claude'))),
  listCodex: attempt(() => fs.readdirSync(path.join(realHome, '.codex'))),
  listSsh: attempt(() => fs.readdirSync(path.join(realHome, '.ssh'))),
  readKeychain: attempt(() => fs.closeSync(fs.openSync(path.join(realHome, 'Library', 'Keychains', 'login.keychain-db'), 'r'))),
}));`;

const confined = (run, root, extra = {}) => {
  const { argv, env, sandbox } = sandboxRunArgv({ argv: [process.execPath, '-e', PROBE, REAL_HOME, root], run, egress: run.egress, ...extra });
  assert.equal(sandbox, 'seatbelt');
  const child = spawnSync(argv[0], argv.slice(1), {
    env, cwd: extra.workspace?.path || run.home, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};

macTest('a real process under the composed profile holds its grant and nothing it goes looking for', () => withRun(async (run, root) => {
  for (const parts of [['.claude'], ['.codex'], ['.ssh'], ['Library', 'Keychains', 'login.keychain-db']]) requireOnHost(...parts);
  const seen = confined(run, root);
  assert.equal(seen.key, GRANTED, 'the granted credential reaches the child');
  assert.equal(seen.withheld, null);
  assert.equal(seen.homedir, run.home);
  assert.equal(seen.writeHome, 'OK', 'the run HOME is writable');
  assert.equal(seen.writeTmp, 'OK', 'TMPDIR, inside the run HOME, is writable');
  for (const name of ['writeOutside', 'writeRealHome', 'writeSharedTmp']) assert.equal(seen[name], 'EPERM', name);
  for (const name of ['listRealHome', 'listClaude', 'statClaude', 'listCodex', 'listSsh', 'readKeychain']) {
    assert.equal(seen[name], 'EPERM', name);
  }
}));

macTest('the login paths stay denied when the workspace is the whole real HOME', () => withRun(async (run, root) => {
  requireOnHost('.claude');
  requireOnHost('.codex');
  const seen = confined(run, root, { workspace: { path: REAL_HOME, access: 'read' } });
  // Positive control: the workspace allow does cover the real HOME, so the
  // denials below are the login-path rules and not the default deny.
  assert.equal(seen.listRealHome, 'OK');
  for (const name of ['listClaude', 'statClaude', 'listCodex', 'listSsh', 'readKeychain']) assert.equal(seen[name], 'EPERM', name);
  assert.equal(seen.writeRealHome, 'EPERM', 'a read workspace takes no writes');
  assert.equal(seen.writeHome, 'OK');
}));

// SBPL top-level forms, skipping comments and quoted strings.
const sbplRules = (profile) => {
  const text = profile.split('\n').filter((line) => !line.trimStart().startsWith(';')).join('\n');
  const rules = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
    } else if (ch === '(') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) rules.push(text.slice(start, i + 1));
    }
  }
  assert.equal(depth, 0);
  return rules;
};
const KEYCHAIN = /com\.apple\.(?:securityd|SecurityServer)/;

macTest('the composed profile allows no securityd lookup, and denies it outright', () => withRun(async (run) => {
  const { argv } = sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress: run.egress });
  assert.equal(argv[0], '/usr/bin/sandbox-exec');
  const rules = sbplRules(argv[2]);
  assert.deepEqual(rules.filter((rule) => rule.startsWith('(allow') && KEYCHAIN.test(rule)), []);
  const denied = rules.filter((rule) => rule.startsWith('(deny mach-lookup') && KEYCHAIN.test(rule));
  assert.equal(denied.length, 1);
  for (const name of ['com.apple.SecurityServer', 'com.apple.securityd', 'com.apple.securityd.xpc']) {
    assert.ok(denied[0].includes(`"${name}"`), name);
  }
  // Control: the cli's default profile does carry them, so the scan can see them.
  const cliDefault = buildSeatbeltProfile({ workspacePath: run.home, executablePath: '/usr/bin/true', statePath: run.home });
  assert.ok(sbplRules(cliDefault).some((rule) => rule.startsWith('(allow mach-lookup') && KEYCHAIN.test(rule)));
}));

macTest('the login-path denies come after every allow, for every real HOME the run names', () => withRun(async (run) => {
  const { argv } = sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress: run.egress });
  const rules = sbplRules(argv[2]);
  const lastAllow = rules.findLastIndex((rule) => rule.startsWith('(allow'));
  for (const path of REAL_HOME_LOGIN_PATHS) {
    const rule = `(deny file-read* file-write* (subpath "${realpathSync(REAL_HOME)}/${path}"))`;
    const at = rules.indexOf(rule);
    assert.ok(at > lastAllow, `${path} is denied after the last allow`);
  }
}));

test('the Seatbelt builder keeps its old output when the new options take their defaults', () => {
  const opts = { workspacePath: '/tmp', executablePath: '/usr/bin/true', statePath: '/tmp' };
  assert.equal(buildSeatbeltProfile({ ...opts, allowKeychainServices: true, denyPaths: [] }), buildSeatbeltProfile(opts));
  assert.throws(() => buildSeatbeltProfile({ ...opts, allowClaudeRuntimeAccess: true, allowKeychainServices: false }), /needs the keychain services/);
  assert.throws(() => buildSeatbeltProfile({ ...opts, denyPaths: ['relative'] }), /denyPaths entry must be an absolute path/);
});

test('no sandbox is a named failure unless the caller accepts it', () => withRun(async (run, root, egressFor) => {
  const missing = { seatbelt: () => ({ available: false, error: 'sandbox-exec preflight failed' }) };
  const darwin = await egressFor(run, 'darwin');
  assert.throws(
    () => sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress: darwin, platform: 'darwin', detect: missing }),
    (error) => error instanceof RunFailure && error.kind === 'unsupported' && /sandbox-exec preflight failed/.test(error.message),
  );
  const win = await egressFor(run, 'win32');
  assert.throws(
    () => sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress: win, platform: 'win32' }),
    (error) => error instanceof RunFailure && error.kind === 'unsupported' && /win32/.test(error.message),
  );
  const trace = recorder();
  const accepted = sandboxRunArgv({ argv: ['/usr/bin/true', '-x'], run, egress: win, platform: 'win32', require: false, trace });
  assert.deepEqual(accepted, {
    argv: ['/usr/bin/true', '-x'], env: run.env, sandbox: 'none', egress: 'none', reason: 'no supported OS sandbox on win32',
  });
  assert.deepEqual(trace.events, [{ type: 'sandbox.applied', data: { sandbox: 'none', reason: 'no supported OS sandbox on win32' } }]);
  // An unsandboxed darwin run gets no proxy variables either: a route with no fence.
  const none = sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress: darwin, platform: 'darwin', detect: missing, require: false });
  assert.equal(none.egress, 'none');
  assert.deepEqual(none.env, run.env);
}));

macTest('a sandboxed result is traced too', () => withRun(async (run) => {
  const trace = recorder();
  assert.equal(sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress: run.egress, trace }).sandbox, 'seatbelt');
  assert.deepEqual(trace.events, [{ type: 'sandbox.applied', data: { sandbox: 'seatbelt' } }]);
}));

test('a run placed where the sandbox cannot hold it is refused', () => withRun(async (run, root, egressFor) => {
  const { egress } = run;
  assert.throws(() => sandboxRunArgv({ argv: ['true'], run, egress }), /absolute path/);
  assert.throws(() => sandboxRunArgv({ argv: ['/usr/bin/true'], run: {}, egress }), /prepareRunEnv/);
  const atRealHome = { ...run, home: REAL_HOME };
  const atRealHomeEgress = await egressFor(atRealHome);
  assert.throws(() => sandboxRunArgv({ argv: ['/usr/bin/true'], run: atRealHome, egress: atRealHomeEgress }), /holds the real HOME/);
  const inLogin = { ...run, home: join(REAL_HOME, '.commonly', 'x') };
  const inLoginEgress = await egressFor(inLogin);
  assert.throws(() => sandboxRunArgv({ argv: ['/usr/bin/true'], run: inLogin, egress: inLoginEgress }), /inside a login path/);
  assert.throws(() => sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress, workspace: { path: join(REAL_HOME, '.ssh') } }), /workspace is inside a login path/);
}));

test('sandboxRunArgv refuses a run without its own egress handle', () => withRun(async (run, root, egressFor) => {
  assert.throws(() => sandboxRunArgv({ argv: ['/usr/bin/true'], run }), /egress must be startRunEgress's result/);
  assert.throws(() => sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress: { port: run.egress.port } }), /egress must be/);
  const otherEgress = await egressFor({ ...run });
  assert.throws(() => sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress: otherEgress }), /egress must be/);
  const winEgress = await egressFor(run, 'win32');
  assert.throws(() => sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress: winEgress, platform: process.platform }), /another platform/);
}));
