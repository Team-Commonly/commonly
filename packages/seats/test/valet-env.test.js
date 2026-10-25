import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync as readdir, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunEnv } from '../src/valet/env.js';
import { createTraceStore } from '../src/trace/store.js';
import { RunFailure } from '../src/failures.js';

const REAL_HOME = homedir();
const GRANTED = 'sk-granted-0123456789abcdef';
const WITHHELD = 'sk-withheld-fedcba9876543210';

const recorder = () => { const events = []; return { events, emit: (type, data) => events.push({ type, data }) }; };
const withScratch = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'seats-valet-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// The child reports what it can see; the assertions run in the parent.
const PROBE = `
const os = require('os'); const fs = require('fs'); const path = require('path');
process.stdout.write(JSON.stringify({
  env: process.env,
  homedir: os.homedir(),
  claude: fs.existsSync(path.join(os.homedir(), '.claude')),
  codex: fs.existsSync(path.join(os.homedir(), '.codex')),
}));`;
const probe = (env, cwd) => {
  const child = spawnSync(process.execPath, ['-e', PROBE], { env, cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};

test('a real child sees only the granted key, a throwaway HOME, and no path to the real login', () => withScratch(async (root) => {
  // A planted "real" home with both login dirs, so the result never depends on the host
  // (a CI runner or a bare container has neither).
  const loginHome = mkdtempSync(join(tmpdir(), 'seats-login-home-'));
  for (const dir of ['.claude', '.codex']) {
    mkdirSync(join(loginHome, dir), { mode: 0o700 });
    writeFileSync(join(loginHome, dir, 'credentials.json'), '{"planted":true}');
  }
  // Positive control: a child given that HOME directly can reach both, so "not reachable" below is a real result.
  const direct = probe({ ...process.env, HOME: loginHome }, loginHome);
  assert.equal(direct.claude, true, 'positive control: the probe sees ~/.claude when HOME points at it');
  assert.equal(direct.codex, true, 'positive control: the probe sees ~/.codex when HOME points at it');
  // The parent's own env, with both secrets planted, is the base the run is cut from.
  const baseEnv = { ...process.env, HOME: loginHome, OPENAI_API_KEY: GRANTED, ANTHROPIC_API_KEY: WITHHELD, CLAUDE_CONFIG_DIR: join(loginHome, '.claude') };
  const trace = recorder();
  const run = await prepareRunEnv({
    grant: { credentials: [{ name: 'OPENAI_API_KEY', from: 'env' }] }, baseEnv, root, trace,
  });
  try {
    const seen = probe(run.env, run.home);
    assert.equal(seen.env.OPENAI_API_KEY, GRANTED, 'the granted key reaches the child');
    assert.equal(seen.env.ANTHROPIC_API_KEY, undefined, 'a parent secret the grant does not name is absent');
    assert.equal(seen.env.CLAUDE_CONFIG_DIR, undefined);
    assert.ok(!JSON.stringify(seen.env).includes(WITHHELD));
    assert.equal(seen.env.HOME, run.home);
    assert.equal(seen.homedir, run.home);
    assert.ok(run.home.startsWith(root));
    for (const [name, value] of Object.entries(seen.env)) {
      assert.ok(!value.includes(loginHome), `${name} leaks the login HOME path: ${value}`);
      assert.ok(!value.includes(REAL_HOME), `${name} leaks the real HOME path: ${value}`);
    }
    assert.equal(seen.claude, false, '~/.claude is not reachable via HOME');
    assert.equal(seen.codex, false, '~/.codex is not reachable via HOME');
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
      assert.ok(seen.env[name].startsWith(`${run.home}/`), `${name} sits inside the run HOME`);
      assert.equal(statSync(seen.env[name]).mode & 0o777, 0o700, `${name} is 0700`);
    }
    assert.equal(statSync(run.home).mode & 0o777, 0o700);
    assert.deepEqual(run.granted, ['OPENAI_API_KEY']);
    assert.deepEqual(trace.events, [{ type: 'credential.granted', data: { names: ['OPENAI_API_KEY'] } }]);
  } finally {
    await run.cleanup();
    rmSync(loginHome, { recursive: true, force: true });
  }
  assert.equal(existsSync(run.home), false, 'cleanup removes the HOME');
}));

test('the base env keeps only the allowlist, and PATH loses entries under the real home', () => withScratch(async (root) => {
  const baseEnv = {
    HOME: REAL_HOME, PATH: `/usr/bin:${REAL_HOME}/.local/bin:/bin`, LANG: 'en_US.UTF-8', LC_ALL: 'C', TERM: 'xterm', TZ: 'UTC',
    SSL_CERT_FILE: '/etc/ssl/cert.pem', NO_COLOR: '1', CI: '1', USER: 'someone', SSH_AUTH_SOCK: '/tmp/agent.sock', AWS_PROFILE: 'prod', GH_TOKEN: 'ghp_x',
  };
  const run = await prepareRunEnv({ grant: {}, baseEnv, root });
  try {
    assert.deepEqual(Object.keys(run.env).sort(), [
      'CI', 'HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'SSL_CERT_FILE', 'TERM', 'TMPDIR', 'TZ',
      'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
    assert.equal(run.env.PATH, '/usr/bin:/bin');
  } finally { await run.cleanup(); }
}));

test('file and resolver credentials resolve; resolveSecret sees the name and spec', () => withScratch(async (root) => {
  const keyFile = join(root, 'key.txt');
  writeFileSync(keyFile, 'from-file-value\n', { mode: 0o600 });
  const calls = [];
  const run = await prepareRunEnv({
    grant: { credentials: [
      { name: 'FILE_KEY', from: 'file', ref: keyFile },
      { name: 'VAULT_KEY', from: 'resolver', ref: 'vault://team/key' },
      { name: 'RENAMED_KEY', from: 'env', ref: 'SOURCE_KEY' },
    ] },
    baseEnv: { SOURCE_KEY: 'from-env-value' },
    resolveSecret: async (name, spec) => { calls.push([name, spec.ref]); return 'from-resolver-value'; },
    root,
  });
  try {
    assert.equal(run.env.FILE_KEY, 'from-file-value');
    assert.equal(run.env.VAULT_KEY, 'from-resolver-value');
    assert.equal(run.env.RENAMED_KEY, 'from-env-value');
    assert.equal(run.env.SOURCE_KEY, undefined, 'the source name is not copied across too');
    assert.deepEqual(calls, [['VAULT_KEY', 'vault://team/key']]);
  } finally { await run.cleanup(); }
}));

test('an unresolvable credential fails credential_denied, emits its name only, and leaves no HOME', () => withScratch(async (root) => {
  const cases = [
    { name: 'resolver returns nothing', resolveSecret: async () => undefined },
    { name: 'resolver throws with the value in its message', resolveSecret: async () => { throw new Error(`boom ${GRANTED}`); } },
    { name: 'resolver returns empty', resolveSecret: async () => '' },
    { name: 'no resolver at all', resolveSecret: undefined },
  ];
  for (const c of cases) {
    const trace = recorder();
    await assert.rejects(prepareRunEnv({
      grant: { credentials: [{ name: 'OPENAI_API_KEY', from: 'env' }, { name: 'VAULT_KEY', from: 'resolver' }] },
      baseEnv: { OPENAI_API_KEY: GRANTED }, resolveSecret: c.resolveSecret, root, trace,
    }), (error) => {
      assert.ok(error instanceof RunFailure, c.name);
      assert.equal(error.kind, 'credential_denied');
      assert.match(error.message, /VAULT_KEY/);
      assert.ok(!error.message.includes(GRANTED));
      return true;
    });
    assert.deepEqual(trace.events, [{ type: 'credential.denied', data: { name: 'VAULT_KEY', reason: 'unresolved' } }], c.name);
  }
  await assert.rejects(prepareRunEnv({ grant: { credentials: [{ name: 'GONE', from: 'file', ref: join(root, 'missing') }] }, root }), /credential_denied/);
  await assert.rejects(prepareRunEnv({ grant: { credentials: [{ name: 'GONE', from: 'env' }] }, baseEnv: {}, root }), /credential_denied/);
  assert.deepEqual(readdir(root), [], 'every failed prepare removed its HOME');
}));

test('a credential the adapter requires but the grant does not name is denied before any HOME is made', () => withScratch(async (root) => {
  const trace = recorder();
  await assert.rejects(prepareRunEnv({
    grant: { credentials: [] }, baseEnv: { ANTHROPIC_API_KEY: WITHHELD }, require: ['ANTHROPIC_API_KEY'], root, trace,
  }), (error) => error.kind === 'credential_denied' && /not in the run grant/.test(error.message));
  assert.deepEqual(trace.events, [{ type: 'credential.denied', data: { name: 'ANTHROPIC_API_KEY', reason: 'not_granted' } }]);
  assert.deepEqual(readdir(root), []);
}));

test('no credential value ever reaches the serialized trace store', () => withScratch(async (root) => {
  const store = createTraceStore({ root: join(root, 'trace') });
  const run = store.startRun({ runId: 'valet-scan-1' });
  const keyFile = join(root, 'k');
  writeFileSync(keyFile, 'sk-file-secret-aaaaaaaaaaaa');
  const prepared = await prepareRunEnv({
    grant: { credentials: [
      { name: 'OPENAI_API_KEY', from: 'env' },
      { name: 'FILE_KEY', from: 'file', ref: keyFile },
      { name: 'VAULT_KEY', from: 'resolver' },
    ] },
    baseEnv: { OPENAI_API_KEY: GRANTED, ANTHROPIC_API_KEY: WITHHELD },
    resolveSecret: async () => 'sk-resolver-secret-bbbbbbbbbbbb',
    root,
    ctx: { trace: run },
  });
  await prepared.cleanup();
  await assert.rejects(prepareRunEnv({
    grant: { credentials: [{ name: 'OPENAI_API_KEY', from: 'env' }, { name: 'VAULT_KEY', from: 'resolver' }] },
    baseEnv: { OPENAI_API_KEY: GRANTED }, resolveSecret: async () => { throw new Error(GRANTED); }, root, ctx: { trace: run },
  }));
  const raw = readFileSync(join(root, 'trace', 'runs', 'valet-scan-1.jsonl'), 'utf8') + readFileSync(join(root, 'trace', 'index.jsonl'), 'utf8');
  assert.deepEqual(store.readRun('valet-scan-1').map((e) => e.type), ['credential.granted', 'credential.denied']);
  for (const value of [GRANTED, WITHHELD, 'sk-file-secret-aaaaaaaaaaaa', 'sk-resolver-secret-bbbbbbbbbbbb']) {
    assert.ok(!raw.includes(value), `trace carries a credential value: ${value}`);
  }
}));
