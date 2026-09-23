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
 * The stub `npm` answers by argument shape, so the assertions above are about
 * this script's decisions, not about the network. The wiring half is asserted
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
 *   STUB_FAILS_UNTIL=n        the first n `<name>@<version>` lookups 404
 *   STUB_NEVER_PUBLISHED=1    every such lookup 404s
 *   STUB_LATEST               what `dist-tags` and `<name>` lookups serve
 *   STUB_SLEEP_SECONDS        how long each `npm view` takes
 * The call log and attempt counter are files next to the stub: the attempt
 * count is the assertion, so it must come from outside this script's output.
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
  'if [ "$verb" = "version" ]; then',
  '  n=$(( $(cat "$STUB_LOG.attempts" 2>/dev/null || echo 0) + 1 ))',
  '  echo "$n" > "$STUB_LOG.attempts"',
  '  if [ "${STUB_NEVER_PUBLISHED:-0}" = "1" ] || [ "$n" -le "${STUB_FAILS_UNTIL:-0}" ]; then',
  '    echo "npm error code E404" >&2',
  '    echo "npm error 404 No match found for version" >&2',
  '    exit 1',
  '  fi',
  '  echo "${STUB_LATEST:-0.0.0}"',
  '  exit 0',
  'fi',
  'echo "stub: unexpected npm call: $*" >&2',
  'exit 1',
  '',
].join('\n');

const withStub = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readback-stub-'));
  fs.writeFileSync(path.join(dir, 'npm'), stubSource, { mode: 0o755 });
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

  test('the budget is honoured: with a 2s budget and a 1s interval it stops at 3 attempts', () => {
    const { dir, log } = withStub();
    const result = runScript(withEnv(dir, log, {
      STUB_NEVER_PUBLISHED: '1',
      STUB_LATEST: REGISTRY_SERVES,
      READBACK_INTERVAL_SECONDS: '1',
      READBACK_TIMEOUT_SECONDS: '2',
    }));

    expect(result.status).toBe(1);
    expect(attempts(log)).toBe(3);
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
    // The banner a human reads first: what follows it is the registry's
    // actual state, and it is the line that turns a red run into a
    // diagnosis instead of a mystery.
    expect(result.stdout).toContain(`--- what the registry serves for ${NAME} ---`);
    expect(result.stdout).toMatch(new RegExp(`dist-tags: .*${REGISTRY_SERVES}`));
    expect(result.stdout).toMatch(new RegExp(`latest: +${REGISTRY_SERVES}`));
    expect(result.stdout).toContain('E404');
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
