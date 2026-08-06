#!/usr/bin/env node
/**
 * Guard for the LiteLLM boot-time patch runner in
 *   k8s/helm/commonly/templates/agents/litellm-deployment.yaml
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-02..05 the litellm proxy crash-looped for 79 hours (762 restarts,
 * whole agent fleet dark). Three boot-time source patches shared one resolution
 * mechanism -- `os.path.dirname(litellm.__file__)` -- evaluated by a `python3 -c`
 * process whose CWD was /app. Two copies of the package exist in that image:
 *
 *   /app/litellm                                       <- source checkout ("shadow")
 *   /app/.venv/lib/python3.13/site-packages/litellm     <- what the proxy imports
 *
 * `python3 -c` puts '' (CWD) at sys.path[0], so the patcher resolved to the
 * shadow. The proxy runs as the console script /app/.venv/bin/litellm, whose
 * sys.path[0] is the script's directory, so it resolved to site-packages.
 * Every patch edited a real file, in the right package, that the process it was
 * protecting never imported -- and then "verified" itself by reading back the
 * same path it had just written. That check is closed by construction: it
 * confirms the write landed where the writer aimed, which was never in doubt.
 *
 * Measured in the deployed image (2026-08-06), for the record:
 *
 *   proxy (console script)          -> .../site-packages/litellm   <- ground truth
 *   bare python3, raw,   cwd=/app   -> /app/litellm                <- the bug
 *   venv python3, raw,   cwd=/app   -> /app/litellm                <- the bug
 *   bare python3, cwd-stripped      -> .../site-packages/litellm   <- correct
 *   venv python3, cwd-stripped      -> .../site-packages/litellm   <- correct
 *
 * Note which lever actually moves the result: the CWD-strip is load-bearing, the
 * interpreter pin is not (in that image bare python3 IS the venv python). Keep
 * the pin -- correct-by-construction beats correct-by-an-accident-of-PATH -- but
 * a future edit that keeps the pin and drops the strip reintroduces the outage
 * verbatim. That is the specific trade this guard exists to make un-shippable.
 *
 * WHAT THIS CHECKS
 * ----------------
 * The runner's decision table, against synthetic two-tree fixtures:
 *
 *   1. happy path          both copies present, patterns match -> patch + EFFECT verified, exit 0
 *   2. idempotent re-run   second run reports "already applied", exit 0, no double-apply
 *   3. gate off            device-login patch skipped, no FATAL, exit 0
 *   4. non-critical miss   proxy file absent -> WARNING, boot continues, exit 0
 *   5. critical miss       proxy file absent + gate on -> FATAL, exit 1
 *   6. shadow-only         proxy copy absent, shadow present -> must NOT claim
 *                          EFFECT verified off the shadow write   <- the SEV cell
 *   7. pattern drift       file present, anchor absent -> not effective, criticality decides
 *
 * Cases 4/5 also cover the crash found in review of #857's first commit: the
 * effect-check `open(proxy_target).read()` was unguarded, so a missing file
 * raised FileNotFoundError inside the `for p in PATCHES` loop -- aborting before
 * the critical third patch was attempted at all. A boot-abort and a wrong premise
 * are indistinguishable at the 10-minute mark, which is what made it worth a gate.
 *
 * WHAT THIS DOES *NOT* CHECK (deliberately)
 * -----------------------------------------
 * - Interpreter resolution. The runner's `PYBIN=/app/.venv/bin/python3` hard-require
 *   is an image fact; it cannot be exercised outside the image. Verified separately
 *   by probing the deployed image directly.
 * - Whether the `old` anchors still match real upstream litellm. Fixtures are
 *   derived from the chart's OWN PATCHES entries, so this stays green across an
 *   upstream bump that the runner would (correctly) WARN about. Anchor drift is
 *   what the runner's own "pattern not found" branch is for.
 * - Shell-level quoting of the heredoc'd YAML beyond the `\"` unescape below.
 *
 * Usage:  node scripts/verify-litellm-patch-runner.js [--verbose]
 * Exit 0 = all cases pass. Exit 1 = a case failed (or extraction broke).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const VERBOSE = process.argv.includes('--verbose');
const REPO_ROOT = path.resolve(__dirname, '..');
// Overridable so the guard can be pointed at a mutated copy to prove it
// discriminates. A guard that only ever passes proves nothing; see the
// mutation checks in the PR that introduced this file.
const CHART =
  process.env.LITELLM_CHART ||
  path.join(REPO_ROOT, 'k8s/helm/commonly/templates/agents/litellm-deployment.yaml');

const START_RE = /^\s*"\$PYBIN"\s+-c\s+"\s*$/;
const END_RE = /^\s*"\s+"\$\{CHATGPT_DISABLE_DEVICE_LOGIN:-\}"/;

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

/**
 * Pull the python runner out of the YAML args block.
 *
 * The block is a shell double-quoted string, so the only unescape needed is
 * \" -> ". Backslash-n must survive as a two-character sequence: the shell does
 * not treat it specially inside double quotes, and the runner's `old`/`new`
 * fields rely on Python interpreting it.
 */
function extractRunner() {
  if (!fs.existsSync(CHART)) fail(`chart not found: ${CHART}`);
  const lines = fs.readFileSync(CHART, 'utf8').split('\n');

  const start = lines.findIndex((l) => START_RE.test(l));
  if (start === -1) {
    fail(
      'could not find the runner start anchor (`"$PYBIN" -c "`).\n' +
        '  The boot block was restructured. Re-point START_RE, then re-read the\n' +
        '  cases below — a restructure is exactly when they matter most.'
    );
  }
  const relEnd = lines.slice(start + 1).findIndex((l) => END_RE.test(l));
  if (relEnd === -1) fail('could not find the runner end anchor (CHATGPT_DISABLE_DEVICE_LOGIN).');
  const end = start + 1 + relEnd;

  const body = lines.slice(start + 1, end);
  const indents = body
    .filter((l) => l.trim() !== '')
    .map((l) => l.match(/^ */)[0].length);
  const dedent = Math.min(...indents);
  const src = body.map((l) => l.slice(dedent)).join('\n').replace(/\\"/g, '"');

  if (!src.includes('import litellm')) fail('extracted block does not import litellm — extraction is wrong.');
  if (!src.includes('PATCHES')) fail('extracted block has no PATCHES table — extraction is wrong.');
  return src;
}

/** Run the CWD-strip + import prefix with a stub package and dump PATCHES as JSON. */
function introspectPatches(runnerSrc, fixture) {
  const marker = runnerSrc.indexOf('fatal=False');
  if (marker === -1) fail('runner no longer has `fatal=False` — cannot split prefix for introspection.');
  const prefix = runnerSrc.slice(0, marker);
  const prog = `${prefix}\nimport json\nprint("__PATCHES__" + json.dumps([{k: p[k] for k in ("name","rel","marker","critical","enabled","old","new")} for p in PATCHES]))\n`;

  const res = runPython(prog, fixture, ['1']);
  const line = res.stdout.split('\n').find((l) => l.startsWith('__PATCHES__'));
  if (!line) fail(`could not introspect PATCHES.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return JSON.parse(line.slice('__PATCHES__'.length));
}

/**
 * MUST invoke via `python3 -c`, exactly as the boot block does.
 *
 * This is load-bearing, not stylistic. `python3 -c` puts '' (CWD) at sys.path[0];
 * `python3 somefile.py` puts the *script's directory* there instead. Running the
 * runner from a file therefore never reproduces CWD-shadowing, and every
 * behavioural case below would pass against a runner with the CWD-strip deleted
 * — the guard would be blind to the precise defect it exists to catch.
 * (Found exactly that way: the first version of this harness used a temp file,
 * and mutation-testing it caught the strip removal only via the static regex.)
 *
 * sys.argv under `-c` is ['-c', ...args], so args[0] lands at sys.argv[1] —
 * matching `"$PYBIN" -c "…" "${CHATGPT_DISABLE_DEVICE_LOGIN:-}"`.
 */
function runPython(src, fixture, argv) {
  return spawnSync('python3', ['-c', src, ...argv], {
    cwd: fixture.app, // mirrors the container WORKDIR (/app)
    env: { ...process.env, PYTHONPATH: fixture.site, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  });
}

/**
 * Two-tree fixture mirroring the image:
 *   <root>/site/litellm  -> stands in for site-packages (the PROXY-resolved copy)
 *   <root>/app/litellm   -> stands in for the /app checkout (the SHADOW copy)
 * CWD is <root>/app, so a runner that fails to strip CWD resolves to the shadow —
 * i.e. the bug reproduces here exactly as it did in production.
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-patch-guard-'));
  const site = path.join(root, 'site');
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(site, 'litellm'), { recursive: true });
  fs.mkdirSync(path.join(app, 'litellm'), { recursive: true });
  fs.writeFileSync(path.join(site, 'litellm', '__init__.py'), '');
  fs.writeFileSync(path.join(app, 'litellm', '__init__.py'), '');
  return { root, site, app, proxyRoot: path.join(site, 'litellm'), shadowRoot: path.join(app, 'litellm') };
}

function writeTarget(rootDir, rel, content) {
  const p = path.join(rootDir, ...rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function removeTarget(rootDir, rel) {
  const p = path.join(rootDir, ...rel);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** Materialize both copies for every patch, each containing its own `old` anchor. */
function seed(fixture, patches, opts = {}) {
  const { skipProxyFor = [], skipShadowFor = [], driftFor = [] } = opts;
  for (const p of patches) {
    const body = driftFor.includes(p.name)
      ? '# upstream refactored this file; the anchor is gone\npass\n'
      : `# fixture for ${p.name}\n${p.old}\n`;
    if (!skipProxyFor.includes(p.name)) writeTarget(fixture.proxyRoot, p.rel, body);
    else removeTarget(fixture.proxyRoot, p.rel);
    if (!skipShadowFor.includes(p.name)) writeTarget(fixture.shadowRoot, p.rel, body);
    else removeTarget(fixture.shadowRoot, p.rel);
  }
}

function markerIn(fixture, rootKey, patch) {
  const p = path.join(fixture[rootKey], ...patch.rel);
  if (!fs.existsSync(p)) return false;
  return fs.readFileSync(p, 'utf8').includes(patch.marker);
}

// --------------------------------------------------------------------------

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function main() {
  console.log('litellm patch-runner guard');
  console.log(`  chart: ${path.relative(REPO_ROOT, CHART)}`);

  const runnerSrc = extractRunner();
  const bootstrap = makeFixture();
  const patches = introspectPatches(runnerSrc, bootstrap);
  const critical = patches.filter((p) => p.critical).map((p) => p.name);
  const nonCritical = patches.filter((p) => !p.critical).map((p) => p.name);

  console.log(
    `  patches: ${patches.length} (critical: ${critical.join(', ') || 'none'}; ` +
      `non-critical: ${nonCritical.join(', ') || 'none'})\n`
  );

  assert(critical.length > 0, 'no critical patch found — the FATAL path would be untested');
  const CRIT = critical[0];
  const NONCRIT = nonCritical[0];

  // GATE ON = argv[1] non-empty, mirroring "${CHATGPT_DISABLE_DEVICE_LOGIN:-}".
  const ON = ['1'];
  const OFF = [''];

  const run = (opts, argv) => {
    const f = makeFixture();
    seed(f, patches, opts);
    const r = runPython(runnerSrc, f, argv);
    if (VERBOSE) console.log(`\n--- ${JSON.stringify(opts)} argv=${JSON.stringify(argv)}\n${r.stdout}${r.stderr}`);
    return { f, r };
  };

  check('1. happy path — every patch applies and verifies against the proxy copy', () => {
    const { f, r } = run({}, ON);
    assert(r.status === 0, `expected exit 0, got ${r.status}\n${r.stdout}${r.stderr}`);
    for (const p of patches) {
      assert(r.stdout.includes(`${p.name} patch EFFECT verified`), `no EFFECT verified for ${p.name}`);
      assert(markerIn(f, 'proxyRoot', p), `marker missing from PROXY copy for ${p.name}`);
    }
    assert(!/FATAL|WARNING/.test(r.stdout), `unexpected FATAL/WARNING:\n${r.stdout}`);
  });

  check('2. idempotent — a second run re-verifies and does not double-apply', () => {
    const f = makeFixture();
    seed(f, patches);
    const first = runPython(runnerSrc, f, ON);
    assert(first.status === 0, `first run failed: ${first.status}`);
    const after = fs.readFileSync(path.join(f.proxyRoot, ...patches[0].rel), 'utf8');

    const second = runPython(runnerSrc, f, ON);
    assert(second.status === 0, `second run exit ${second.status}\n${second.stdout}`);
    assert(second.stdout.includes('already applied'), 'second run did not report "already applied"');
    const after2 = fs.readFileSync(path.join(f.proxyRoot, ...patches[0].rel), 'utf8');
    assert(after === after2, 'second run mutated an already-patched file (double-apply)');
    for (const p of patches) {
      assert(second.stdout.includes(`${p.name} patch EFFECT verified`), `no EFFECT verified on re-run for ${p.name}`);
    }
  });

  check('3. gate off — critical patch is skipped, and skipping is not FATAL', () => {
    const { r } = run({}, OFF);
    assert(r.status === 0, `expected exit 0 with gate off, got ${r.status}\n${r.stdout}`);
    assert(r.stdout.includes(`${CRIT} patch: skipped (gate off)`), `no skip line for ${CRIT}`);
    assert(!r.stdout.includes('FATAL'), `gate-off must not be FATAL:\n${r.stdout}`);
  });

  if (NONCRIT) {
    check('4. non-critical file missing — WARNING, boot continues (exit 0)', () => {
      const { r } = run({ skipProxyFor: [NONCRIT], skipShadowFor: [NONCRIT] }, ON);
      assert(r.status === 0, `non-critical miss must not abort boot; got exit ${r.status}\n${r.stdout}${r.stderr}`);
      assert(r.stdout.includes(`WARNING: LiteLLM ${NONCRIT} patch NOT effective`), `no WARNING for ${NONCRIT}`);
      assert(
        r.stdout.includes(`${CRIT} patch EFFECT verified`),
        `the critical patch must still run after a non-critical miss — this is the #857 ` +
          `d5fbc276 crash: an unguarded open() aborted the loop before the critical patch was attempted`
      );
      assert(!/Traceback|FileNotFoundError/.test(r.stdout + r.stderr), 'runner raised instead of warning');
    });
  }

  check('5. critical file missing + gate on — FATAL and exit 1', () => {
    const { r } = run({ skipProxyFor: [CRIT], skipShadowFor: [CRIT] }, ON);
    assert(r.status === 1, `expected exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
    assert(r.stdout.includes(`FATAL: LiteLLM ${CRIT} patch NOT effective`), `no FATAL line for ${CRIT}`);
    assert(!/Traceback|FileNotFoundError/.test(r.stdout + r.stderr), 'runner raised instead of reporting FATAL');
  });

  check('6. shadow-only — patching the shadow must NOT count as effect (the SEV cell)', () => {
    const { f, r } = run({ skipProxyFor: [CRIT] }, ON);
    assert(
      !r.stdout.includes(`${CRIT} patch EFFECT verified`),
      'claimed EFFECT verified while the proxy-resolved copy was absent — this is the 79-hour outage'
    );
    assert(r.status === 1, `a critical patch effective only in the shadow must abort; got exit ${r.status}`);
    assert(markerIn(f, 'shadowRoot', patches.find((p) => p.name === CRIT)), 'shadow copy should still have been patched');
  });

  check('7. pattern drift — anchor gone means not effective, criticality decides', () => {
    const { r } = run({ driftFor: [CRIT] }, ON);
    assert(r.stdout.includes('pattern not found'), 'no "pattern not found" line on anchor drift');
    assert(!r.stdout.includes(`${CRIT} patch EFFECT verified`), 'claimed EFFECT verified with the anchor absent');
    assert(r.status === 1, `critical anchor drift must abort; got exit ${r.status}`);
  });

  check('8. the CWD-strip is present — dropping it reintroduces the outage', () => {
    assert(
      /sys\.path\s*=\s*\[\s*p\s+for\s+p\s+in\s+sys\.path\s+if\s+p\s+not\s+in\s*\(\s*''\s*,\s*cwd\s*\)\s*\]/.test(runnerSrc),
      'the CWD-strip is gone from the runner. Without it, `python3 -c` resolves ' +
        'import litellm to the /app checkout and every patch silently misses the ' +
        'copy the proxy imports. This is the exact 2026-08-02 failure.'
    );
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} cases passed`);
  if (failed.length) {
    console.error('\nThe boot block changed in a way that breaks a guarantee the fleet depends on.');
    process.exit(1);
  }
}

main();
