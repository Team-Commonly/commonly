#!/usr/bin/env node

/**
 * Run one affected CLI Jest file twice in an isolated TMPDIR and fail if any
 * test-created temp directory survives either run. The full CLI suite runs in
 * CI separately; this is a cheap regression guard for the teardown contract.
 */
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const target = process.argv[2] || '__tests__/adapters.claude.environment.test.mjs';
const prefixes = [
  'opencode-adapter-test-',
  'cli-mcp-home-',
  'cli-mcp-pin-',
  'cli-mcp-home-old-',
  'commonly-mcp-home-jest-',
];

const bytesUnder = async (path) => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await bytesUnder(join(path, entry));
  return total;
};

const snapshot = async (root) => {
  const entries = (await readdir(root)).filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
  let bytes = 0;
  for (const entry of entries) bytes += await bytesUnder(join(root, entry));
  return { count: entries.length, bytes, entries };
};

const run = (probeRoot) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    '--experimental-vm-modules',
    'node_modules/.bin/jest',
    target,
    '--runInBand',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: probeRoot, TMP: probeRoot, TEMP: probeRoot },
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Jest exited with ${signal || `code ${code}`}`));
  });
});

// Short root on purpose: the provider-proxy tests bind Unix sockets under the
// probe TMPDIR, and macOS caps a socket path at ~104 bytes, so a deep
// $TMPDIR makes them fail with EINVAL. CI runs on Linux where /tmp is the default.
const probeRoot = await mkdtemp(join('/tmp', 'commonly-cli-temp-guard-'));
try {
  for (let pass = 1; pass <= 2; pass += 1) {
    const before = await snapshot(probeRoot);
    await run(probeRoot);
    const after = await snapshot(probeRoot);
    console.log(`CLI temp cleanup pass ${pass}: before=${before.count} dirs/${before.bytes} bytes, after=${after.count} dirs/${after.bytes} bytes`);
    if (after.count !== 0 || after.bytes !== 0) {
      throw new Error(`CLI test temp directories survived pass ${pass}: ${after.entries.join(', ')}`);
    }
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}
