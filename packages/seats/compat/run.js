#!/usr/bin/env node
/**
 * The compatibility matrix runner.
 *
 *   node compat/run.js --targets compat/targets.json --out <dir> [--prefix <dir>]
 *
 * Starts the fake provider, runs every enabled target against every check,
 * and writes <dir>/results.json and <dir>/index.html. A failing check is data,
 * not a crash: the exit code is 0 whenever the matrix was produced.
 * `--prefix` (or COMPAT_PREFIX) is where compat/install.js put the binaries.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { CHECKS, runCheck } from './checks.js';
import { createHarness, killDescendants } from './harness.js';
import { renderMatrix } from './render.js';
import { loadAdapter, resolveBinary, targetLabel } from './targets.js';

export const RESULTS_SCHEMA = 'seats-compat/1';
export const DEFAULT_TIMEOUTS = Object.freeze({ turnMs: 30000, stallMs: 8000, graceMs: 5000, checkMs: 45000 });

const rowsFor = (target, statusOf) => CHECKS.map((check) => {
  const { status, detail } = statusOf(check);
  return { target: targetLabel(target), cli: target.cli, version: target.version, check: check.id, status, detail, ms: 0 };
});

const timeoutsFor = (target, overrides) => {
  const merged = { ...DEFAULT_TIMEOUTS, ...(target.timeouts || {}), ...(overrides || {}) };
  if (!overrides?.checkMs && !target.timeouts?.checkMs) merged.checkMs = merged.turnMs + 15000;
  return merged;
};

// Adapters whose detect() reads the host PATH see the pinned binary first,
// for the length of this target only.
const withPath = async (binaryPath, fn) => {
  if (!binaryPath) return fn();
  const before = process.env.PATH;
  process.env.PATH = [dirname(binaryPath), before].filter(Boolean).join(delimiter);
  try { return await fn(); } finally { process.env.PATH = before; }
};

/** Run one target through the suite. Always returns one row per check. */
export const runTarget = async (target, { provider, prefix, checks = CHECKS, timeouts, log = () => {} } = {}) => {
  const label = targetLabel(target);
  const all = (status, detail) => rowsFor(target, () => ({ status, detail })).filter((row) => checks.some((c) => c.id === row.check));
  if (target.enabled === false) return all('skip', 'target disabled');
  const binary = resolveBinary(target, { prefix });
  if (binary?.missing) return all('skip', binary.missing);
  const loaded = await loadAdapter(target, { binaryPath: binary?.path });
  if (loaded.skip) return all('skip', loaded.skip);
  if (loaded.error) return all('fail', loaded.error);
  if (binary?.path && !existsSync(binary.path)) {
    return checks.map((check) => ({
      target: label, cli: target.cli, version: target.version, check: check.id, ms: 0,
      ...(check.id === 'detect' ? { status: 'fail', detail: `binary not installed at ${binary.label}` } : { status: 'skip', detail: 'binary not installed' }),
    }));
  }
  const harness = createHarness({
    adapter: loaded.adapter, provider, binaryPath: binary?.path, timeouts: timeoutsFor(target, timeouts),
  });
  const rows = [];
  try {
    await withPath(binary?.path, async () => {
      for (const check of checks) {
        const outcome = await runCheck(check, { ...target, binaryLabel: binary?.label }, harness);
        log(`${label} ${check.id}: ${outcome.status}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
        rows.push({ target: label, cli: target.cli, version: target.version, check: check.id, ...outcome });
      }
    });
  } finally {
    harness.dispose();
    killDescendants();
  }
  return rows;
};

export const hostInfo = () => ({ os: `${platform()} ${release()}`, platform: platform(), arch: arch(), node: process.version });

/** Run every target and return the results document (not yet written). */
export const runMatrix = async (targets, { prefix, checks = CHECKS, timeouts, log, now = () => new Date() } = {}) => {
  const fake = await startFakeProvider();
  // A key-shaped value that is fake by construction: the leak checks look for
  // exactly this string, and no real provider would accept it.
  const provider = { ...fake, apiKey: `sk-compat-${randomBytes(16).toString('hex')}` };
  const rows = [];
  try {
    for (const target of targets) rows.push(...await runTarget(target, { provider, prefix, checks, timeouts, log }));
  } finally {
    await fake.close();
  }
  return {
    schema: RESULTS_SCHEMA,
    generatedAt: now().toISOString(),
    host: hostInfo(),
    checks: checks.map(({ id, title }) => ({ id, title })),
    targets: targets.map((t) => ({
      target: targetLabel(t), cli: t.cli, version: t.version, adapter: t.adapter,
      enabled: t.enabled !== false, requires: t.requires || null, note: t.note || null,
    })),
    rows,
    totals: ['pass', 'fail', 'skip'].reduce((acc, s) => ({ ...acc, [s]: rows.filter((r) => r.status === s).length }), {}),
  };
};

export const writeOutputs = (results, outDir) => {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, 'results.json');
  const html = join(outDir, 'index.html');
  writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(html, renderMatrix(results));
  return { json, html };
};

export const loadTargets = (path) => {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const targets = Array.isArray(parsed) ? parsed : parsed?.targets;
  if (!Array.isArray(targets)) throw new Error(`${path} must hold an array of targets`);
  for (const t of targets) {
    if (!t?.cli || !t?.version || !t?.adapter) throw new Error(`every target needs cli, version and adapter: ${JSON.stringify(t)}`);
  }
  return targets;
};

const argValue = (argv, name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1] ?? null;
};

export const main = async (argv = process.argv.slice(2)) => {
  const targetsPath = argValue(argv, '--targets');
  const out = argValue(argv, '--out');
  if (!targetsPath || !out) {
    process.stderr.write('usage: node compat/run.js --targets <targets.json> --out <dir> [--prefix <dir>]\n');
    return 2;
  }
  const prefix = argValue(argv, '--prefix') || process.env.COMPAT_PREFIX || null;
  const results = await runMatrix(loadTargets(resolve(targetsPath)), {
    prefix, log: (line) => process.stdout.write(`${line}\n`),
  });
  const paths = writeOutputs(results, resolve(out));
  const { pass, fail, skip } = results.totals;
  process.stdout.write(`pass ${pass}  fail ${fail}  skip ${skip}\n${paths.json}\n${paths.html}\n`);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Exit explicitly: an adapter that ignored cancellation must not keep the
  // nightly job alive after the matrix is written.
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`compat run failed: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
