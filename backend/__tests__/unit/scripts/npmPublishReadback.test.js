/**
 * Guards scripts/verify-npm-publish-readback.sh, the registry poll that closes
 * the "version moved but nobody published" loop.
 *
 * Earned 2026-09-23 (TASK-100). cli 0.1.65 (run 35498255344) and 0.1.66 (run
 * 35804128707) both published fine — the registry moved, `npx` returned the new
 * version — and this step went red anyway because it gave up after ~60s while
 * npm's own documentation puts propagation at "a few minutes". The loop lived
 * inline in the workflow, where nothing in the suite could reach it, and its
 * failure said only which version it had been looking for: not whether the
 * registry was slow, stale, or unreadable with the token in use.
 *
 * So this file asserts three things, each of which was the defect:
 *   1. a slow propagation succeeds (the retry loop actually retries);
 *   2. the budget is honoured, and its default is minutes rather than seconds;
 *   3. exhaustion reports what the registry DID serve, and exits non-zero —
 *      a read-back that cannot say what it saw is the same false negative one
 *      layer down.
 *
 * TASK-115 adds a fourth: the poll reads the VERSION DOCUMENT (2.4KB,
 * `cf-cache-status: DYNAMIC`), not the packument (130KB, `cache-control:
 * public, max-age=300` — the same 300s as the budget, so the old form raced a
 * cache rather than propagation: 31 E404s then success, Vera 71761-71763).
 * The `curl` stub therefore answers ONLY the version URL, and a request for the
 * packument fails loudly — that is what makes the endpoint a property under
 * test instead of a detail of the implementation.
 *
 * The stubs answer by argument shape, so the assertions above are about this
 * script's decisions, not about the network. The wiring half is asserted
 * against the workflow text because a workflow body cannot be executed here.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-npm-publish-readback.sh');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'npm-publish.yml');

const NAME = '@commonlyai/cli';
const WANT = '0.1.68';
const REGISTRY_SERVES = '0.1.67';

/**
 * A stub `npm` whose behaviour is driven by env, so each test states the
 * registry's condition rather than mocking this script's internals.
 *   STUB_NAME                 the package name (so the two `version` shapes differ)
 * After TASK-115 `npm` serves the DIAGNOSTIC reads only — the two packument
 * shapes printed under the exhaustion banner — so it no longer counts attempts.
 *   STUB_NAME                 the package name (so the two `version` shapes differ)
 *   STUB_LATEST               what `dist-tags` and `<name>` lookups serve
 *   STUB_SLEEP_SECONDS        how long each read takes
 * The call log and the attempt counter are files next to the stubs, because the
 * attempt count is an assertion about the poll and has to come from outside
 * this script's output.
 */
const stubSource = [
  '#!/usr/bin/env bash',
  "printf '%s\\n' \"$*\" >> \"$STUB_LOG.calls\"",
  'sleep "${STUB_SLEEP_SECONDS:-0}"',
  'if [ "$1" != "view" ]; then',
  '  echo "stub: unexpected npm call: $*" >&2',
  '  exit 1',
  'fi',
  'target="$2"; verb="${3:-}"; fourth="${4:-}"',
  'if [ "$verb" = "dist-tags" ] && [ "$fourth" = "--json" ]; then',
  "  printf '{\"latest\":\"%s\"}\\n' \"${STUB_LATEST:-0.0.0}\"",
  '  exit 0',
  'fi',
  'if [ "$verb" = "version" ] && [ "$target" = "$STUB_NAME" ]; then',
  '  echo "${STUB_LATEST:-0.0.0}"',
  '  exit 0',
  'fi',
  'echo "stub: unexpected npm call: $*" >&2',
  'exit 1',
  '',
].join('\n');

/**
 * The stub `curl` the poll goes through since TASK-115. It answers ONLY
 * `<registry>/<name>/<version>` — the version document — and refuses the
 * packument with a distinguishable message, so "which endpoint did this read"
 * is a property under test rather than a detail of the implementation. The
 * attempt counter lives here now: this is the call the retry loop and the
 * budget are about.
 *   STUB_FAILS_UNTIL=n        the first n version-document reads 404
 *   STUB_NEVER_PUBLISHED=1    every such read 404s
 *   STUB_LATEST               the version the document reports
 */
const curlSource = [
  '#!/usr/bin/env bash',
  "printf '%s\\n' \"$*\" >> \"$STUB_LOG.calls\"",
  'sleep "${STUB_SLEEP_SECONDS:-0}"',
  'if [ "${1:-}" != "-fsS" ]; then',
  '  echo "stub curl: the poll must call curl -fsS (got: $*)" >&2',
  '  exit 1',
  'fi',
  'url="${@: -1}"',
  'case "$url" in',
  '  https://registry.npmjs.org/*) rest="${url#https://registry.npmjs.org/}" ;;',
  '  *) echo "stub curl: unexpected registry host: $url" >&2; exit 1 ;;',
  'esac',
  'if [ "$(printf %s "$rest" | tr -cd / | wc -c | tr -d " ")" != "1" ]; then',
  '  echo "stub curl: PACKUMENT read ($url) — the read-back must read the version document" >&2',
  '  exit 1',
  'fi',
  'name="${rest%%/*}"; version="${rest##*/}"',
  'n=$(( $(cat "$STUB_LOG.attempts" 2>/dev/null || echo 0) + 1 ))',
  'echo "$n" > "$STUB_LOG.attempts"',
  'if [ "${STUB_NEVER_PUBLISHED:-0}" = "1" ] || [ "$n" -le "${STUB_FAILS_UNTIL:-0}" ]; then',
  '  echo "curl: (56) The requested URL returned error: 404" >&2',
  '  exit 56',
  'fi',
  "printf '{\"name\":\"%s\",\"version\":\"%s\"}\\n' \"$name\" \"${STUB_LATEST:-0.0.0}\"",
  'exit 0',
  '',
].join('\n');

const withStub = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readback-stub-'));
  fs.writeFileSync(path.join(dir, 'npm'), stubSource, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'curl'), curlSource, { mode: 0o755 });
  return { dir, log: path.join(dir, 'npm-log') };
};

// `timeout` is load-bearing: the defect this file now guards against is a loop
// that cannot terminate, and without a kill-timeout the suite HANGS on it —
// which reads as an infrastructure problem rather than a failed assertion.
const runScript = (env, { timeoutMs = 30000 } = {}) => {
  try {
    const stdout = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '', signal: null };
  } catch (err) {
    return {
      status: err.status ?? null,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      signal: err.signal ?? null,
    };
  }
};

const attempts = (log) => Number(fs.readFileSync(`${log}.attempts`, 'utf8').trim());

const withEnv = (dir, log, extra) => ({
  PATH: `${dir}:${process.env.PATH}`,
  STUB_LOG: log,
  STUB_NAME: NAME,
  NAME,
  WANT,
  ...extra,
});

describe('npm publish read-back', () => {
  test('a slow propagation succeeds: the retry loop outlasts the old 60s window', () => {
    const { dir, log } = withStub();
    // Five 404s then success. The previous inline loop allowed six attempts but
    // slept AFTER the sixth, so this is the boundary that made 0.1.65/0.1.66 red.
    const result = runScript(withEnv(dir, log, {
      STUB_FAILS_UNTIL: '5',
      STUB_LATEST: WANT,
      READBACK_INTERVAL_SECONDS: '0',
      READBACK_TIMEOUT_SECONDS: '30',
    }));

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`${WANT} is live`));
    expect(attempts(log)).toBe(6);
  });

  test('the poll reads the uncached version document, not the edge-cached packument', () => {
    // TASK-115. `npm view pkg@version version` fetches the 130KB packument,
    // which is served `public, max-age=300` — the same 300s as this loop's
    // budget — so a copy cached just before the publish stays stale for the
    // whole run. The version document is `cf-cache-status: DYNAMIC`. The stub
    // refuses the packument outright, so this fails if the endpoint regresses.
    const { dir, log } = withStub();
    const result = runScript(withEnv(dir, log, {
      STUB_NEVER_PUBLISHED: '1',
      STUB_LATEST: REGISTRY_SERVES,
      READBACK_INTERVAL_SECONDS: '0',
      READBACK_TIMEOUT_SECONDS: '0',
    }));

    const calls = fs.readFileSync(`${log}.calls`, 'utf8').trim().split('\n');
    // The log is shared with the diagnostic reads the exhaustion banner makes,
    // so the assertion separates them: every curl call is the version document,
    // and no npm call is the shape the poll used to make.
    const curlCalls = calls.filter((c) => c.startsWith('-fsS '));
    expect(curlCalls.length).toBeGreaterThan(0);
    for (const call of curlCalls) {
      expect(call).toBe(`-fsS https://registry.npmjs.org/@commonlyai%2fcli/${WANT}`);
    }
    for (const call of calls.filter((c) => c.startsWith('view '))) {
      // The old poll shape was `view <name>@<version> version`; the surviving
      // npm calls are `view <name> dist-tags --json` and `view <name> version`,
      // which carry no second `@`.
      expect(call).not.toMatch(/^view .+@[0-9].* version$/);
    }
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`GET https://registry.npmjs.org/@commonlyai%2fcli/${WANT}`);
    expect(result.stdout).toContain('version document');
  });

  // The count is a BOUND, not a number, because the script's budget clock is
  // `date +%s` — one-second granularity (verify-npm-publish-readback.sh:55,60)
  // — and every attempt spawns a stub process. Measured on the same code:
  //   · a fast stub           → 3 attempts
  //   · a loaded CI runner    → 2  (#1838's run, job 107092464765: expected 3,
  //                                received 2, in a PR touching nothing here)
  //   · STUB_SLEEP_SECONDS=1  → 1  (reproduced on demand on this box)
  // An exact count made the only required check flake red for every open PR,
  // because the assertion was about the runner's speed rather than about this
  // script's decision. What the contract promises is that the budget stops the
  // loop within one interval of expiring, which is what is asserted here — and
  // the slow row keeps a strict assertion by pinning the cost profile that the
  // fast row is racing.
  test.each([
    ['a fast stub', {}, 2, 3],
    ['a stub that spends the budget in its own calls', { STUB_SLEEP_SECONDS: '1' }, 1, 2],
  ])('the budget is honoured: %s stops inside one interval of expiring', (_label, extra, min, max) => {
    const { dir, log } = withStub();
    const result = runScript(withEnv(dir, log, {
      STUB_NEVER_PUBLISHED: '1',
      STUB_LATEST: REGISTRY_SERVES,
      READBACK_INTERVAL_SECONDS: '1',
      READBACK_TIMEOUT_SECONDS: '2',
      ...extra,
    }));

    // The decision that matters is unchanged by the count: it gives up, it says
    // so, and it is not a success. A residual is stated rather than hidden — a
    // first attempt costing more than the entire budget would still read as 1,
    // and that is the cost profile the second row pins deliberately.
    expect(result.status).toBe(1);
    const count = attempts(log);
    expect(count).toBeGreaterThanOrEqual(min);
    expect(count).toBeLessThanOrEqual(max);
  });

  test('the budget is a clock: interval 0 with a non-zero budget still terminates', () => {
    // Vera 71347, reproduced: `elapsed` advanced only by INTERVAL_SECONDS, so at
    // interval 0 it never reached the timeout — 789 attempts in 8s, still
    // reporting 0s, killed by an external alarm. In the release job that is not a
    // red step but a run held to the six-hour limit. The assertion is that the
    // script EXITS 1 (not that it is fast): the kill-timeout turns a hang into a
    // failure, and attempts > 1 proves the loop actually ran more than once.
    const { dir, log } = withStub();
    const started = Date.now();
    const result = runScript(
      withEnv(dir, log, {
        STUB_NEVER_PUBLISHED: '1',
        READBACK_INTERVAL_SECONDS: '0',
        READBACK_TIMEOUT_SECONDS: '2',
      }),
      { timeoutMs: 15000 },
    );

    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(attempts(log)).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(12000);
  });

  test('the reported elapsed is a clock, not the sum of the intervals', () => {
    // With interval 0 the old arithmetic reported `0s after publish` no matter
    // how long the poll took, because it only ever added INTERVAL_SECONDS. A
    // 1.2s stub makes the two disagree by construction.
    const { dir, log } = withStub();
    const result = runScript(withEnv(dir, log, {
      STUB_SLEEP_SECONDS: '1.2',
      STUB_LATEST: WANT,
      READBACK_INTERVAL_SECONDS: '0',
      READBACK_TIMEOUT_SECONDS: '30',
    }));

    expect(result.status).toBe(0);
    expect(attempts(log)).toBe(1);
    expect(result.stdout).toMatch(/is live \(attempt 1, [1-9]\d*s after publish\)/);
  });

  test('exhaustion names what the registry serves and exits non-zero', () => {
    const { dir, log } = withStub();
    const result = runScript(withEnv(dir, log, {
      STUB_NEVER_PUBLISHED: '1',
      STUB_LATEST: REGISTRY_SERVES,
      READBACK_INTERVAL_SECONDS: '0',
      READBACK_TIMEOUT_SECONDS: '0',
    }));

    expect(result.status).toBe(1);
    // The version that never appeared, the one the registry actually serves,
    // and npm's own last error — the three facts the old message withheld.
    expect(result.stdout).toContain(`::error::${NAME}@${WANT}`);
    // The endpoint the poll read is named in the banner: "which question did we
    // ask" is part of the diagnosis, and the packument lines below are labelled
    // as the cached reads they are.
    expect(result.stdout).toContain(`GET https://registry.npmjs.org/@commonlyai%2fcli/${WANT}`);
    expect(result.stdout).toContain('uncached');
    // The banner a human reads first: what follows it is the registry's
    // actual state, and it is the line that turns a red run into a
    // diagnosis instead of a mystery.
    expect(result.stdout).toContain(`--- what the registry serves for ${NAME} ---`);
    expect(result.stdout).toMatch(new RegExp(`dist-tags: .*${REGISTRY_SERVES}`));
    expect(result.stdout).toMatch(new RegExp(`latest: +${REGISTRY_SERVES}`));
    expect(result.stdout).toContain('The requested URL returned error: 404');
    expect(attempts(log)).toBe(1);
  });

  test('a missing WANT is refused rather than polling for nothing', () => {
    const { dir, log } = withStub();
    const bare = runScript(withEnv(dir, log, { WANT: '' }));

    expect(bare.status).not.toBe(0);
    expect(`${bare.stdout}${bare.stderr}`).toMatch(/WANT is required/);
    expect(fs.existsSync(`${log}.attempts`)).toBe(false);
  });

  test('the default budget is minutes, not the ~60s that produced the false negative', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const timeout = /READBACK_TIMEOUT_SECONDS:-(\d+)/.exec(source);
    const interval = /READBACK_INTERVAL_SECONDS:-(\d+)/.exec(source);

    expect(timeout).not.toBeNull();
    expect(Number(timeout[1])).toBeGreaterThanOrEqual(300);
    // A floor on the interval too: a tight loop spends the same budget
    // hammering the registry's API, and npm rate-limits.
    expect(interval).not.toBeNull();
    expect(Number(interval[1])).toBeGreaterThanOrEqual(5);
  });
});

describe('the workflow calls that script under the publish gate', () => {
  const workflow = () => fs.readFileSync(WORKFLOW, 'utf8');

  test('the read-back step runs the script, and still only after a publish', () => {
    const body = workflow();
    const step = body.slice(body.indexOf('      - name: Read it back from the registry'));

    expect(step).toContain('scripts/verify-npm-publish-readback.sh');
    expect(step).toContain("if: steps.cmp.outputs.action == 'publish'");
    // The values the script polls for come from the compare step, not literals.
    expect(step).toContain('NAME: ${{ steps.cmp.outputs.name }}');
    expect(step).toContain('WANT: ${{ steps.cmp.outputs.repo_v }}');
    // The interpreter is named: the file's exec bit does not survive every
    // checkout or archive path, and a bare path would fail there.
    expect(step).toMatch(/run: bash "\$GITHUB_WORKSPACE/);
  });

  test('the inline loop that gave up after ~60s is gone, not shadowed', () => {
    const body = workflow();
    expect(body).not.toMatch(/for i in 1 2 3 4 5 6/);
    expect(body).not.toMatch(/not visible on the registry after publish/);
    // Exactly one read-back step: a second, older loop left behind would win
    // or lose by ordering, and both outcomes are silent.
    expect(body.match(/name: Read it back from the registry/g)).toHaveLength(1);
  });
});
