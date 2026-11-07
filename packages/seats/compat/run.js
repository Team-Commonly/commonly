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
import { isLimitRow, renderMatrix } from './render.js';
import { loadAdapter, resolveBinary, targetLabel } from './targets.js';
import { loadUpstream, upstreamForResults } from './upstream.js';

export { isLimitRow };
export const RESULTS_SCHEMA = 'seats-compat/1';
export const DEFAULT_TIMEOUTS = Object.freeze({
  turnMs: 30000, stallMs: 8000, graceMs: 5000, checkMs: 45000, retryWindowMs: 20000,
});

/**
 * A target may declare `limits: { <checkId>: { note, fixedIn? } }`: a check
 * that fails for a reason that belongs to that CLI version, not to the
 * adapter. The row keeps its real status; the limit rides along so the page
 * can say "limit of this version" and where it is fixed, and so a declared
 * limit that stops reproducing is visible as a pass that carries one.
 */
export const limitOf = (target, checkId) => {
  const limit = target?.limits?.[checkId];
  if (!limit || typeof limit.note !== 'string' || !limit.note) return null;
  return { note: limit.note, ...(typeof limit.fixedIn === 'string' && limit.fixedIn ? { fixedIn: limit.fixedIn } : {}) };
};

/** pass / fail / skip / limit counts; `fail` counts only failures no limit explains. */
export const totalsOf = (rows) => ({
  pass: rows.filter((r) => r.status === 'pass').length,
  fail: rows.filter((r) => r.status === 'fail' && !isLimitRow(r)).length,
  skip: rows.filter((r) => r.status === 'skip').length,
  limit: rows.filter(isLimitRow).length,
});

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
  // The probe instance is the same export built with probeOptions on top, so
  // a check can see the agent with nothing of the adapter's own in between.
  let probeAdapter = null;
  if (target.probeOptions) {
    const probe = await loadAdapter({ ...target, options: { ...(target.options || {}), ...target.probeOptions } }, { binaryPath: binary?.path });
    if (probe.adapter && probe.adapter !== loaded.adapter) probeAdapter = probe.adapter;
    else log(`${label}: probeOptions ignored (${probe.error || probe.skip || 'the export is an adapter, not a factory'})`);
  }
  const harness = createHarness({
    adapter: loaded.adapter, provider, binaryPath: binary?.path, timeouts: timeoutsFor(target, timeouts), probeAdapter,
  });
  const rows = [];
  try {
    await withPath(binary?.path, async () => {
      for (const check of checks) {
        const outcome = await runCheck(check, { ...target, binaryLabel: binary?.label }, harness);
        log(`${label} ${check.id}: ${outcome.status}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
        const limit = limitOf(target, check.id);
        rows.push({ target: label, cli: target.cli, version: target.version, check: check.id, ...outcome, ...(limit ? { limit } : {}) });
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
export const runMatrix = async (targets, { prefix, checks = CHECKS, timeouts, log, upstream = [], now = () => new Date() } = {}) => {
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
    totals: totalsOf(rows),
    upstream: upstreamForResults(upstream, rows),
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
    process.stderr.write('usage: node compat/run.js --targets <targets.json> --out <dir> [--prefix <dir>] [--upstream <upstream.json>]\n');
    return 2;
  }
  const prefix = argValue(argv, '--prefix') || process.env.COMPAT_PREFIX || null;
  // Upstream bug rows live beside the targets unless --upstream names a file.
  const named = argValue(argv, '--upstream');
  const upstreamPath = resolve(named || join(dirname(resolve(targetsPath)), 'upstream.json'));
  if (named && !existsSync(upstreamPath)) {
    process.stderr.write(`no upstream file at ${upstreamPath}\n`);
    return 2;
  }
  const results = await runMatrix(loadTargets(resolve(targetsPath)), {
    prefix, upstream: loadUpstream(upstreamPath), log: (line) => process.stdout.write(`${line}\n`),
  });
  const paths = writeOutputs(results, resolve(out));
  const { pass, fail, skip, limit } = results.totals;
  process.stdout.write(`pass ${pass}  fail ${fail}  limit ${limit}  skip ${skip}\n${paths.json}\n${paths.html}\n`);
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
