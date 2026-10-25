#!/usr/bin/env node
/**
 * Install each enabled target's pinned binary into a job-local prefix.
 *
 *   node compat/install.js --targets compat/targets.json --prefix <dir>
 *
 * Nothing is installed globally. A release asset is downloaded, checked
 * against its pinned sha256 BEFORE it is unpacked, and extracted into
 * <prefix>/<cli>-<version>/. An npm spec is installed into that directory with
 * --ignore-scripts, so no package's install hook runs. A target whose adapter
 * module is absent is not installed: it would only be skipped by the runner.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDirOf, parseAdapterSpec, platformKey, resolveBinary } from './targets.js';
import { loadTargets } from './run.js';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const run = (command, args, opts = {}) => {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} exited ${result.status}`);
};

export const installRelease = async ({ url, sha256: expected }, dir, { fetchImpl = fetch } = {}) => {
  if (!/^[0-9a-f]{64}$/.test(String(expected || ''))) throw new Error(`release asset ${url} has no pinned sha256`);
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download ${url} answered ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const actual = sha256(body);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${url}: expected ${expected}, got ${actual}`);
  mkdirSync(resolve(dir, '..'), { recursive: true });
  const scratch = mkdtempSync(join(resolve(dir, '..'), '.download-'));
  try {
    const archive = join(scratch, 'asset');
    writeFileSync(archive, body);
    mkdirSync(dir, { recursive: true });
    const flag = /\.tar\.bz2$|\.tbz2?$/.test(url) ? '-xjf' : '-xzf';
    run('tar', [flag, archive, '-C', dir]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

export const installNpm = (spec, dir) => {
  mkdirSync(dir, { recursive: true });
  run('npm', ['install', '--prefix', dir, '--ignore-scripts', '--no-save', '--no-audit', '--no-fund', spec]);
};

export const installTarget = async (target, { prefix, platform = platformKey(), fetchImpl } = {}) => {
  const binary = target.binary;
  if (target.enabled === false) return { skipped: 'disabled' };
  if (!binary || binary.path) return { skipped: 'no binary to install' };
  if (!existsSync(parseAdapterSpec(target.adapter).path)) return { skipped: `adapter module ${target.adapter} is not present` };
  const resolved = resolveBinary(target, { prefix, platform });
  if (resolved?.missing) return { skipped: resolved.missing };
  const dir = installDirOf(target, prefix);
  if (binary.release) await installRelease(binary.release[platform], dir, { fetchImpl });
  else if (binary.npm) installNpm(binary.npm, dir);
  else return { skipped: 'binary names neither release nor npm' };
  if (!existsSync(resolved.path)) throw new Error(`${target.cli} installed but ${resolved.label} is missing`);
  chmodSync(resolved.path, 0o755);
  return { installed: resolved.path };
};

const argValue = (argv, name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1] ?? null;
};

export const main = async (argv = process.argv.slice(2)) => {
  const targetsPath = argValue(argv, '--targets');
  const prefix = argValue(argv, '--prefix');
  if (!targetsPath || !prefix) {
    process.stderr.write('usage: node compat/install.js --targets <targets.json> --prefix <dir>\n');
    return 2;
  }
  let failed = 0;
  for (const target of loadTargets(resolve(targetsPath))) {
    try {
      const outcome = await installTarget(target, { prefix: resolve(prefix) });
      process.stdout.write(`${target.cli}@${target.version}: ${outcome.installed ? `installed ${outcome.installed}` : `skipped (${outcome.skipped})`}\n`);
    } catch (error) {
      // One CLI failing to install must not hide the rest of the matrix; the
      // runner reports it as "binary not installed".
      failed += 1;
      process.stderr.write(`${target.cli}@${target.version}: install failed: ${error?.message || error}\n`);
    }
  }
  return failed ? 1 : 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`compat install failed: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
