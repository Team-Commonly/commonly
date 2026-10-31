import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTarget } from '../compat/install.js';
import { resolveBinary } from '../compat/targets.js';

const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'seats-compat-install-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// A release tarball holding one executable, served from memory.
const tarball = (dir) => {
  const src = join(dir, 'src');
  mkdirSync(src);
  writeFileSync(join(src, 'tool'), '#!/bin/sh\necho tool 2.0.0\n');
  const archive = join(dir, 'tool.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', src, 'tool']).status, 0);
  const body = readFileSync(archive);
  return { body, sha256: createHash('sha256').update(body).digest('hex') };
};
const serve = (body) => async () => ({ ok: true, status: 200, arrayBuffer: async () => body });
const target = (asset) => ({
  cli: 'tool', version: '2.0.0', adapter: 'src/adapters/stub.js#default', enabled: true,
  binary: { bin: 'tool', release: { 'linux-x64': { url: 'https://example.invalid/tool.tar.gz', ...asset } } },
});

test('a release asset is installed into <prefix>/<cli>-<version> only when its sha256 matches', () => withTmp(async (dir) => {
  const { body, sha256 } = tarball(dir);
  const prefix = join(dir, 'prefix');
  const ok = await installTarget(target({ sha256 }), { prefix, platform: 'linux-x64', fetchImpl: serve(body) });
  assert.equal(ok.installed, join(prefix, 'tool-2.0.0', 'tool'));
  assert.ok(existsSync(ok.installed));

  const other = join(dir, 'other');
  await assert.rejects(
    installTarget(target({ sha256: 'a'.repeat(64) }), { prefix: other, platform: 'linux-x64', fetchImpl: serve(body) }),
    /sha256 mismatch/,
  );
  assert.equal(existsSync(join(other, 'tool-2.0.0', 'tool')), false, 'nothing is unpacked on a mismatch');
  await assert.rejects(
    installTarget(target({}), { prefix: other, platform: 'linux-x64', fetchImpl: serve(body) }),
    /no pinned sha256/,
  );
}));

test('install skips what the runner would skip', () => withTmp(async (dir) => {
  const absent = { ...target({ sha256: 'a'.repeat(64) }), adapter: 'src/adapters/not-landed.js#x' };
  assert.match((await installTarget(absent, { prefix: dir, platform: 'linux-x64' })).skipped, /not present/);
  assert.match((await installTarget(target({ sha256: 'a'.repeat(64) }), { prefix: dir, platform: 'win32-x64' })).skipped, /win32-x64/);
  assert.equal((await installTarget({ ...target({}), enabled: false }, { prefix: dir })).skipped, 'disabled');
}));

test('binary paths resolve per platform and never put the host home in the label', () => {
  const npm = { cli: 'oc', version: '1.0.0', binary: { npm: 'oc@1.0.0', bin: { 'linux-x64': 'node_modules/oc-linux-x64/bin/oc' } } };
  const resolved = resolveBinary(npm, { prefix: '/opt/compat', platform: 'linux-x64' });
  assert.equal(resolved.path, '/opt/compat/oc-1.0.0/node_modules/oc-linux-x64/bin/oc');
  assert.equal(resolved.label, '<prefix>/oc-1.0.0/node_modules/oc-linux-x64/bin/oc');
  assert.match(resolveBinary(npm, { prefix: '/opt', platform: 'darwin-x64' }).missing, /darwin-x64/);
  assert.match(resolveBinary(npm, { platform: 'linux-x64' }).missing, /prefix/);
});

test('a pip spec is pinned exactly and installed into <dir>/venv from wheels only', () => withTmp(async (dir) => {
  const calls = [];
  const runImpl = (command, args) => {
    calls.push([command, ...args]);
    // Stand in for the venv and the console script pip would create.
    if (args[0] === 'install') {
      mkdirSync(join(dir, 'prefix', 'tool-2.0.0', 'venv', 'bin'), { recursive: true });
      writeFileSync(join(dir, 'prefix', 'tool-2.0.0', 'venv', 'bin', 'tool'), '#!/bin/sh\n');
    }
  };
  const pip = {
    cli: 'tool', version: '2.0.0', adapter: 'src/adapters/stub.js#default', enabled: true,
    binary: { pip: 'tool-cli==2.0.0', bin: 'venv/bin/tool' },
  };
  const prefix = join(dir, 'prefix');
  const ok = await installTarget(pip, { prefix, platform: 'linux-x64', pipOptions: { python: 'python3.12', runImpl } });
  assert.equal(ok.installed, join(prefix, 'tool-2.0.0', 'venv', 'bin', 'tool'));
  const venv = join(prefix, 'tool-2.0.0', 'venv');
  assert.deepEqual(calls[0], ['python3.12', '-m', 'venv', venv]);
  assert.equal(calls[1][0], join(venv, 'bin', 'pip'));
  assert.ok(calls[1].includes('--only-binary=:all:'), 'no sdist, so no setup.py runs');
  assert.equal(calls[1].at(-1), 'tool-cli==2.0.0');

  for (const loose of ['tool-cli', 'tool-cli>=2', 'tool-cli==2.0.0; rm -rf /', '-r requirements.txt']) {
    await assert.rejects(
      installTarget({ ...pip, binary: { ...pip.binary, pip: loose } }, { prefix: join(dir, 'p2'), platform: 'linux-x64', pipOptions: { runImpl } }),
      /must pin one exact version/,
    );
  }
}));
