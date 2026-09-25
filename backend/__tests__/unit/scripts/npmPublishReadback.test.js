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
 * public, max-age=300`). The old form raced a cache rather than propagation —
 * 31 E404s then success, Vera 71761-71763 — and the reason is the endpoint, not
 * the number: a packument read answers from the CDN's copy, so it reports the
 * cache's age instead of the publish's state at any budget. The 300s TTL and
 * the budget happened to match when that was measured; the budget in force is
 * printed at startup now, and the forbidden form would be just as wrong.
 * The `curl` stub therefore answers ONLY the version URL, and a request for the
 * packument fails loudly — that is what makes the endpoint a property under
 * test instead of a detail of the implementation.
 *
 * TASK-116 adds a fifth: the TAG must move. A published version whose `latest`
 * still points at the previous one is a different defect from a version that
 * never appeared, and the two must not share a message. The assertion is exact
 * because nothing here publishes with `--tag` — that reason is asserted to be in
 * the script, so the day someone adds one, the comment is what says why the
 * check was allowed to be this strict.
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
 *   STUB_VERSION_ABSENT_AFTER=n  the first n reads serve the document and every
 *                             later read 404s — the inverse of STUB_FAILS_UNTIL,
 *                             and the only way to model a registry that flaps to
 *                             absent AFTER a live reading (TASK-117a)
 *   STUB_LATEST               the version the version-document reports
 *   STUB_TAG_LATEST           what latest points at in the dist-tags document
 *                             (defaults to STUB_LATEST, i.e. the tag moved)
 *   STUB_TAG_STATUS           the status the dist-tags read answers (default 200)
 *   STUB_TAG_BEHIND_FOR=n     the first n tag reads still report the old tag
 *   STUB_TAG_BEHIND_VALUE     what they report instead (default 0.0.0)
 *   STUB_TAG_BAD_FOR=n        the first n tag reads do not answer
 *   STUB_TAG_BAD_STATUS       the status they answer instead (default 401)
 */
const curlSource = [
  '#!/usr/bin/env bash',
  "printf '%s\\n' \"$*\" >> \"$STUB_LOG.calls\"",
  'sleep "${STUB_SLEEP_SECONDS:-0}"',
  // Two endpoints, two flag pairs: `-fsS` for the version document (a 404 body
  // must not be parsed) and `-sS` for the dist-tags document (the status code is
  // the finding, so it must be readable). Each flag is refused on the other URL.
  'mode=""',
  'case "${1:-}" in',
  '  -fsS) mode=version ;;',
  '  -sS) mode=tag ;;',
  '  *) echo "stub curl: unexpected flags: $*" >&2; exit 1 ;;',
  'esac',
  'url="${@: -1}"',
  'case "$url" in',
  '  https://registry.npmjs.org/*) rest="${url#https://registry.npmjs.org/}" ;;',
  '  *) echo "stub curl: unexpected registry host: $url" >&2; exit 1 ;;',
  'esac',
  'if [ "$mode" = "tag" ]; then',
  '  case "$rest" in',
  '    */dist-tags) ;;',
  '    *) echo "stub curl: -sS used for a URL that is not dist-tags: $url" >&2; exit 1 ;;',
  '  esac',
  '  out=""; prev=""',
  '  for arg in "$@"; do',
  '    if [ "$prev" = "-o" ]; then out="$arg"; fi',
  '    prev="$arg"',
  '  done',
  '  if [ -z "$out" ]; then echo "stub curl: the tag read must use -o (got: $*)" >&2; exit 1; fi',
  // One publish writes two documents; nothing has measured that the registry
  // makes them visible in the same instant. These two knobs are how the harness
  // models that gap: the tag lags for the first n reads, or does not answer for
  // the first n — so "retry inside the budget" is a testable claim rather than
  // an assumption.
  '  n=$(( $(cat "$STUB_LOG.tagreads" 2>/dev/null || echo 0) + 1 ))',
  '  echo "$n" > "$STUB_LOG.tagreads"',
  '  status="${STUB_TAG_STATUS:-200}"',
  '  if [ "$n" -le "${STUB_TAG_BAD_FOR:-0}" ]; then status="${STUB_TAG_BAD_STATUS:-401}"; fi',
  '  latest="${STUB_TAG_LATEST:-${STUB_LATEST:-0.0.0}}"',
  '  if [ "$n" -le "${STUB_TAG_BEHIND_FOR:-0}" ]; then latest="${STUB_TAG_BEHIND_VALUE:-0.0.0}"; fi',
  '  printf %s "$status"',
  '  if [ "$status" = "200" ]; then',
  "    printf '{\"latest\":\"%s\"}\\n' \"$latest\" > \"$out\"",
  '  else',
  "    printf 'Unauthorized\\n' > \"$out\"",
  '  fi',
  '  exit 0',
  'fi',
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
  'if [ "${STUB_VERSION_ABSENT_AFTER:-0}" != "0" ] && [ "$n" -gt "${STUB_VERSION_ABSENT_AFTER}" ]; then',
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

const tagReads = (log) => Number(fs.readFileSync(`${log}.tagreads`, 'utf8').trim() || 0);
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
    // which is served `public, max-age=300`, so a copy cached just before the
    // publish can stay stale by itself. The version document is
    // `cf-cache-status: DYNAMIC`. The stub
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

  describe('the tag must move with the version', () => {
    // The budget is a fixture, not a duration: these rows are about which claim
    // was outstanding at exhaustion, so they spend it in busy-second units
    // instead of waiting out the budget the real job uses.
    const run = (extra) => {
      const { dir, log } = withStub();
      return {
        log,
        result: runScript(withEnv(dir, log, {
          STUB_LATEST: WANT,
          STUB_TAG_LATEST: WANT,
          READBACK_INTERVAL_SECONDS: '0',
          READBACK_TIMEOUT_SECONDS: '30',
          ...extra,
        })),
      };
    };
    const outOfBudget = (extra) => run({ READBACK_TIMEOUT_SECONDS: '2', ...extra });

    test('a publish that moved latest succeeds, and the success line says the tag moved', () => {
      const { result } = run({});
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('latest points at it');
    });

    test('a tag that lags the version and catches up inside the budget is a PASS', () => {
      // One publish writes two documents; nothing has measured that the registry
      // publishes them in the same instant. A live version whose tag is one read
      // behind is a good publish, and this row is the one that says so.
      const { log, result } = run({ STUB_TAG_BEHIND_FOR: '2' });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('latest points at it');
      // It really did take more than one read to get there — otherwise this row
      // would pass for the wrong reason (a one-shot check that happened to be
      // right on the first read).
      expect(tagReads(log)).toBeGreaterThan(1);
    });

    test('one unreadable dist-tags read does not fail the check', () => {
      // A non-200 is a finding at exhaustion, not on a single read: the document
      // not answering once is not the same as the tag not having moved.
      const { log, result } = run({ STUB_TAG_BAD_FOR: '1' });

      expect(result.status).toBe(0);
      expect(tagReads(log)).toBeGreaterThan(1);
    });

    test('a version published without moving latest fails as a tag that did not move', () => {
      // The version IS live; only the tag is behind, and it stays behind for the
      // whole budget. This is not "not published yet" and must not read like it.
      const { log, result } = outOfBudget({ STUB_TAG_LATEST: REGISTRY_SERVES });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('the tag did NOT move');
      expect(result.stdout).toContain(`latest still pointed at '${REGISTRY_SERVES}'`);
      expect(result.stdout).not.toContain('is not visible on the registry');
      // Retried rather than bailing on the first read.
      expect(tagReads(log)).toBeGreaterThan(1);
    });

    test('an unreadable dist-tags document fails as unreadable, not as a tag that did not move', () => {
      // Sustained: a name the registry will not serve answers 401, not 404.
      const { log, result } = outOfBudget({ STUB_TAG_BAD_FOR: '9999' });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('did not answer for 2s');
      expect(result.stdout).not.toContain('did NOT move');
      expect(tagReads(log)).toBeGreaterThan(1);
    });

    test('a version that never appears is still reported as never appearing', () => {
      // The third headline, and the one the other two must not have stolen: a
      // tag state is only meaningful once the version document has answered.
      const { result } = outOfBudget({ STUB_NEVER_PUBLISHED: '1' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('is not visible on the registry');
      expect(result.stdout).not.toContain('the tag did NOT move');
    });

    test('the tag is read from the uncached dist-tags document', () => {
      const { log, result } = run({});
      expect(result.status).toBe(0);

      const calls = fs.readFileSync(`${log}.calls`, 'utf8').trim().split('\n');
      const tagCalls = calls.filter((c) => c.startsWith('-sS '));
      expect(tagCalls.length).toBeGreaterThan(0);
      for (const call of tagCalls) {
        expect(call).toContain('https://registry.npmjs.org/-/package/@commonlyai%2fcli/dist-tags');
      }
      // The tag document is NOT the packument: `npm view dist-tags` would be the
      // cached read TASK-115 removed, one endpoint over.
      expect(tagCalls.some((c) => c.startsWith('-sS -o '))).toBe(true);
    });

    test('the exact assertion carries its reason: nothing here publishes with --tag', () => {
      // The ruling's condition, asserted rather than promised: the assertion is
      // strict BECAUSE there is one publish invocation and no publishConfig.tag,
      // so the day someone adds `--tag` this comment is what tells them why the
      // check reddened.
      const script = fs.readFileSync(SCRIPT, 'utf8');
      expect(script).toContain('publishes without --tag');
      expect(script).toContain('npm-publish.yml:143');
    });
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
  test('a version read that flaps absent AFTER a live reading is reported as a flap, not as a live version with a stale tag', () => {
    // TASK-117(a). `last_tag_state` was assigned only inside the live-read
    // branch, so it survived a later read that saw no version — and the messages
    // attached to that later read then described the earlier one. Two outputs
    // went wrong in the same direction: the retry line announced a live version
    // for a read that had just 404'd, and the exhaustion banner asserted "is live,
    // but latest still pointed at X ... the tag did NOT move" about a version the
    // run had not seen since its first attempt. The fix clears the state on a
    // failed read and gives the earlier finding its own clause.
    //
    // STUB_VERSION_ABSENT_AFTER is the one harness knob this needed:
    // STUB_FAILS_UNTIL models absent-then-live, and this defect is live-then-absent.
    const { dir, log } = withStub();
    const result = runScript(withEnv(dir, log, {
      STUB_LATEST: WANT,
      STUB_TAG_BEHIND_FOR: '99',
      STUB_TAG_BEHIND_VALUE: '0.0.0',
      STUB_VERSION_ABSENT_AFTER: '1',
      // Budget 5, not 1: with a 1s budget a slow first attempt spends it before
      // the second read happens, so the witness would redden on a loaded machine
      // with nothing wrong — measured, while running a mutation ledger: two
      // unrelated mutations appeared to redden this test, and the cause was the
      // budget, not either mutation. Interval 0 keeps it cheap.
      READBACK_TIMEOUT_SECONDS: '5',
      READBACK_INTERVAL_SECONDS: '0',
    }));

    const all = result.stdout + result.stderr;
    // Scoped per attempt, because the first retry line is CORRECT: attempt 1 did
    // see the version, so "is live and latest still points at …" describes it.
    // A first draft of this witness banned that pattern globally and reddened on
    // the correct line — the assertion was the artifact, not the code. What the
    // defect produced was a live-version claim attached to a read that saw no
    // version, so that is what is asserted:
    const retryLines = all.split('\n').filter((l) => l.startsWith('\u00b7 '));
    expect(retryLines.length).toBeGreaterThanOrEqual(2);
    expect(retryLines[0]).toMatch(/is live and latest still points at/);
    retryLines.slice(1).forEach((line) => { expect(line).not.toMatch(/is live/); });
    // The banner's form of the same claim — the one that named a tag that did not
    // move for a run that never saw the version after its first read.
    expect(all).not.toMatch(/is live, but latest still pointed at/);
    // The earlier finding is not discarded — it is attributed to the read it came
    // from, which is the whole point of keeping the state split in two. The
    // elapsed second is matched as a number rather than pinned: it is read from
    // the clock at the first live attempt, so on a loaded machine that attempt
    // lands at 1s, and pinning `0s` made this witness fail with the code correct.
    expect(all).toMatch(/WAS served at \d+s, when the dist-tags read said 'behind'/);
    expect(all).toMatch(/flapping registry rather than an unpropagated publish/);
    expect(all).toMatch(/is not visible on the registry/);
  });

  test('every temp the script creates is named by the single EXIT trap', () => {
    // TASK-117(b). Two traps existed: the first named three temps and was written
    // before the fourth was allocated, so the second silently replaced it. Nothing
    // leaked — the survivor names all four — but the cleanup rule only held if a
    // reader noticed the replacement. Parsed rather than listed, so a temp added
    // later is covered by this test rather than by whoever reviews it.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const temps = [...source.matchAll(/^(\w+)=\$\(mktemp\)$/gm)].map((m) => m[1]);
    const traps = source.match(/^trap '.*' EXIT$/gm) || [];
    expect(temps.length).toBeGreaterThan(0);
    expect(traps).toHaveLength(1);
    temps.forEach((name) => { expect(traps[0]).toContain(`"$${name}"`); });
  });

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
    expect(result.stdout).toMatch(/is live and latest points at it \(attempt 1, [1-9]\d*s after publish\)/);
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
    // ask" is part of the diagnosis.
    expect(result.stdout).toContain(`GET https://registry.npmjs.org/@commonlyai%2fcli/${WANT}`);
    expect(result.stdout).toContain('uncached');
    // The banner a human reads first: what follows it is the registry's
    // actual state, and it is the line that turns a red run into a
    // diagnosis instead of a mystery.
    expect(result.stdout).toContain(`--- what the registry serves for ${NAME} ---`);
    // Both uncached reads are shown as such, with the tag's HTTP status — a
    // non-200 there is a finding, not an absence. The one PACKUMENT read that
    // survives answers the different question "what will a user's npm see",
    // and says that it may lag by itself.
    expect(result.stdout).toContain('dist-tags (uncached');
    expect(result.stdout).toContain(`latest=${REGISTRY_SERVES} [HTTP 200]`);
    expect(result.stdout).toContain('PACKUMENT');
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

  test('the budget in force is the value the script prints — and the number is stated in one place, so a re-tune cannot leave a copy behind', () => {
    // TASK-116 follow-up, recut after wren 73043 and vera 73057. The first
    // version asserted the printed value against a literal AND added an
    // agreement check for three sites — and left six prose restatements outside
    // it, every one shaped like the value then in force. Vera reproduced it:
    // re-tune the value, update the three checked sites, and the suite stays green with six stale
    // copies of the number, including the name of this test. Fewer copies beats
    // more assertions, so this now states the number in ONE place in the script
    // (the default it binds) plus the usage line that documents it, and asserts
    // there is no third — every other mention points at the printed line.
    //
    // The two witnesses are not duplicates of one claim: this one is "the number
    // has one home and the prose agrees with the value in force"; the floor below
    // is "the default did not regress to seconds-scale". Neither implies the
    // other.
    //
    // The run is KILLED rather than allowed to finish, because the default
    // budget is ten minutes and the registry never serves WANT here. The line
    // under test is printed before the first read, so the kill ends the
    // observation window rather than being the assertion.
    const { dir, log } = withStub();
    const result = runScript(withEnv(dir, log, {
      STUB_NEVER_PUBLISHED: '1',
      STUB_LATEST: REGISTRY_SERVES,
      STUB_SLEEP_SECONDS: '0',
    }), { timeoutMs: 3000 });

    expect(result.stdout).toMatch(/read-back budget: \d+s total, \d+s between polls/);

    // The printed line is the source of truth, and the one documented copy must
    // agree with it. Nothing here pins the number itself: a deliberate re-tune
    // that updates both the default and its usage stays green, which is the
    // point — this witness is about agreement, not about the value.
    const effective = /read-back budget: (\d+)s total, (\d+)s between polls/.exec(result.stdout);
    expect(effective).not.toBeNull();

    const scriptText = fs.readFileSync(SCRIPT, 'utf8');
    const budgetDoc = /total wall-clock budget, default (\d+)/.exec(scriptText);
    const intervalDoc = /gap between polls, default (\d+)/.exec(scriptText);
    expect(budgetDoc).not.toBeNull();
    expect(intervalDoc).not.toBeNull();
    expect(budgetDoc[1]).toBe(effective[1]);
    expect(intervalDoc[1]).toBe(effective[2]);

    // And the number itself is stated in exactly two places, both of them
    // read at runtime or by a human who runs the script: the default it binds
    // and the usage line that documents that default. A third copy is the
    // defect this row exists to kill — prose restating the budget that nothing
    // reads — so it fails HERE, naming the line that was added, instead of
    // going stale silently at the next re-tune. Built from the value in force,
    // so a deliberate re-tune that updates both stays green: this is a count,
    // not a pin.
    const numeric = new RegExp(`(?<![\\d])${effective[1]}(?![\\d])`);
    const budgetCopies = scriptText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => numeric.test(line));
    expect(budgetCopies).toEqual([
      `#   READBACK_TIMEOUT_SECONDS        total wall-clock budget, default ${effective[1]}`,
      `TIMEOUT_SECONDS="\${READBACK_TIMEOUT_SECONDS:-${effective[1]}}"`,
    ]);

    // The workflow states none of them: it names the variable and the script
    // prints the value. One copy one file over is the same defect, so the count
    // there is asserted too rather than left to prose discipline.
    const workflowCopies = fs
      .readFileSync(WORKFLOW, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => numeric.test(line));
    expect(workflowCopies).toEqual([]);
  });

  test('the default budget is minutes, not the ~60s that produced the false negative', () => {
    // The invariant as a FLOOR, and the older of the two witnesses: it reddens
    // only on a regression toward the ~60s window that produced the false
    // negative, not on a change to the value in force. That is its whole kill
    // set, and it is why it stays beside the assertion above rather than being
    // replaced by it.
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
