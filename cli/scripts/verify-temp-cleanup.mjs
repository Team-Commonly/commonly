#!/usr/bin/env node

/**
 * Run the CLI Jest files that create temp homes twice in an isolated TMPDIR and
 * fail if anything the tests created survives either run. The full CLI
 * suite runs in CI separately; this is a cheap regression guard for the
 * teardown contract. The default list is the files that leaked ~40 GB
 * (TASK-436); pass file paths to check others.
 *
 * Everything left in the probe root counts except the tools' own caches. It
 * used to count a fixed list of prefixes, and a home under a new prefix
 * (`cli-claude-mcp-home-`) leaked 29 MB unseen: a detached MCP warm that a test
 * started kept writing into it after Jest exited, and the only symptom was this
 * script's final rm failing with ENOTEMPTY on whichever PR was in the queue.
 * That rm still fails the run, now naming what was still being written.
 */
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const targets = process.argv.length > 2
  ? process.argv.slice(2)
  : [
    '__tests__/adapters.opencode.test.mjs',
    '__tests__/adapters.claude.environment.test.mjs',
    '__tests__/adapters.codex.test.mjs',
    '__tests__/adapters.pi.test.mjs',
  ];
// Caches Jest and Node write to TMPDIR for themselves, not for a test.
const toolCaches = [/^jest_/, /^node-compile-cache$/];
// A detached child a test started gets this long to show itself in the probe
// root before the root is read.
const SETTLE_MS = 1500;

const bytesUnder = async (path) => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await bytesUnder(join(path, entry));
  return total;
};

const snapshot = async (root) => {
  const entries = (await readdir(root)).filter((name) => !toolCaches.some((cache) => cache.test(name)));
  let bytes = 0;
  for (const entry of entries) bytes += await bytesUnder(join(root, entry));
  return { count: entries.length, bytes, entries };
};

const run = (probeRoot) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    '--experimental-vm-modules',
    'node_modules/.bin/jest',
    ...targets,
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

// Short root on macOS on purpose: the provider-proxy tests bind Unix sockets
// under the probe TMPDIR, and macOS caps a socket path at ~104 bytes, so the
// deep $TMPDIR there makes them fail with EINVAL. Elsewhere the default is fine.
const probeBase = process.platform === 'darwin' ? '/tmp' : tmpdir();
const probeRoot = await mkdtemp(join(probeBase, 'commonly-cli-temp-guard-'));
try {
  for (let pass = 1; pass <= 2; pass += 1) {
    const before = await snapshot(probeRoot);
    await run(probeRoot);
    await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });
    const after = await snapshot(probeRoot);
    console.log(`CLI temp cleanup pass ${pass}: before=${before.count} dirs/${before.bytes} bytes, after=${after.count} dirs/${after.bytes} bytes`);
    if (after.count !== 0 || after.bytes !== 0) {
      throw new Error(`CLI test temp directories survived pass ${pass}: ${after.entries.join(', ')}`);
    }
  }
} finally {
  try {
    await rm(probeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    // A root that won't go is a leak the snapshots missed. ENOTEMPTY after the
    // retries means something kept writing after the last snapshot, the
    // detached-child case above. exitCode, not a throw, so a leak check's own
    // error stays the one reported when both happen.
    const left = await readdir(probeRoot).catch(() => []);
    const hint = error.code === 'ENOTEMPTY'
      ? ' Something kept writing there after the last snapshot, usually a process a test started that outlived Jest.'
      : '';
    console.error(`CLI temp cleanup could not remove ${probeRoot} (${error.code || error.message}); left in it: ${left.join(', ') || 'nothing readable'}.${hint}`);
    process.exitCode = 1;
  }
}
