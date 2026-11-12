// F453. keyFileReadableRoot and resolveProviderKeyFile's readableRoots: a key
// file a sandbox can read is refused, whatever spelling reaches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyFileReadableRoot, resolveProviderKeyFile } from '../src/wire/provider-proxy.js';

const withKey = async (fn) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seats-keyroots-')));
  const keys = join(root, 'keys');
  const workspace = join(root, 'workspace');
  mkdirSync(keys);
  mkdirSync(workspace);
  const keyFile = join(keys, 'provider.key');
  writeFileSync(keyFile, 'k\n', { mode: 0o600 });
  try { await fn({ root, keys, workspace, keyFile }); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('a subpath root holds the key when it is the key\'s directory or an ancestor', () => withKey(({ root, keys, keyFile }) => {
  assert.equal(keyFileReadableRoot(keyFile, { subpaths: [keys] }), keys);
  assert.equal(keyFileReadableRoot(keyFile, { subpaths: [root] }), root);
  assert.equal(keyFileReadableRoot(keyFile, { subpaths: [join(root, 'workspace')] }), null);
  assert.equal(keyFileReadableRoot(keyFile, { subpaths: [`${keys}-not`] }), null);
}));

test('a literal root holds only the file itself, also through a hard link', () => withKey(({ root, keys, keyFile }) => {
  assert.equal(keyFileReadableRoot(keyFile, { literals: [keys] }), null);
  assert.equal(keyFileReadableRoot(keyFile, { literals: [keyFile] }), keyFile);
  const other = join(root, 'linked');
  linkSync(keyFile, other);
  assert.equal(keyFileReadableRoot(keyFile, { literals: [other] }), other);
}));

test('a root through a symlink, or in other case on a case-insensitive volume, is the same root', () => withKey(({ root, keys, keyFile }) => {
  const alias = join(root, 'alias');
  symlinkSync(keys, alias);
  assert.equal(keyFileReadableRoot(keyFile, { subpaths: [alias] }), alias);
  if (existsSync(keys.toUpperCase())) {
    assert.equal(keyFileReadableRoot(keyFile, { subpaths: [keys.toUpperCase()] }), keys.toUpperCase());
    assert.equal(keyFileReadableRoot(keyFile.toUpperCase(), { subpaths: [keys] }), keys);
  }
}));

test('a root that does not exist is compared as written', () => withKey(({ root, keys }) => {
  assert.equal(keyFileReadableRoot(join(keys, 'later', 'k'), { subpaths: [join(keys, 'later')] }), join(keys, 'later'));
  assert.equal(keyFileReadableRoot(join(keys, 'provider.key'), { subpaths: [join(root, 'missing')] }), null);
}));

test('inodes past 2^53 are compared exactly (macOS sealed volume)', { skip: !existsSync('/usr/share/dict/words') }, () => {
  assert.equal(keyFileReadableRoot('/usr/share/dict/words', { subpaths: ['/usr/bin', '/usr/sbin', '/bin'] }), null);
});

test('resolveProviderKeyFile refuses a key under readableRoots and names the root', () => withKey(async ({ keys, workspace, keyFile }) => {
  await assert.rejects(
    resolveProviderKeyFile({ keyFile }, workspace, 'T', { readableRoots: { subpaths: [keys], literals: [] } }),
    { message: `T provider.keyFile ${keyFile} is inside the seat's sandbox; move it outside ${keys}` },
  );
  assert.equal(await resolveProviderKeyFile({ keyFile }, workspace, 'T'), keyFile);
}));

test('a key file with a second hard link is refused', () => withKey(async ({ root, workspace, keyFile }) => {
  linkSync(keyFile, join(root, 'second-name'));
  await assert.rejects(resolveProviderKeyFile({ keyFile }, workspace, 'T'), /exactly one link/);
}));

test('the workspace check holds for another spelling of the workspace', () => withKey(async ({ root, workspace }) => {
  const inside = join(workspace, 'provider.key');
  writeFileSync(inside, 'k\n', { mode: 0o600 });
  const alias = join(root, 'ws-alias');
  symlinkSync(workspace, alias);
  await assert.rejects(resolveProviderKeyFile({ keyFile: inside }, alias, 'T'), /must be outside the workspace/);
  if (existsSync(inside.toUpperCase())) {
    await assert.rejects(resolveProviderKeyFile({ keyFile: inside.toUpperCase() }, workspace, 'T'), /must be outside the workspace/);
  }
}));
