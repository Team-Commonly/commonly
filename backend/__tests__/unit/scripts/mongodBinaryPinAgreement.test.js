/**
 * Every in-memory mongod a backend test starts must be pinned to the SAME
 * version and the SAME cache dir — the ones `backend/__tests__/utils/mongoBinaryConfig.js`
 * declares. Three arms, all static (this suite starts no mongod of its own):
 *
 *   1. no call site may pass a `version` string literal — guards the VERSION,
 *      which an option overrides and which is therefore load-bearing on every run,
 *   2. every options object passed to a call site must name `downloadDir` —
 *      which is stricter than "passes `binary` options": an object carrying only
 *      `instance` is refused too. That is the safe direction (arm 1 cannot see
 *      a version that is not written inline), and it is kept deliberately. This
 *      arm guards the DIR, whose env overrides the option, so it bites on the
 *      path where globalSetup exports nothing (see the precedences below); and
 *   3. the options must be written INLINE at the call site. A hoisted variable
 *      is refused rather than parsed: arms 1 and 2 read the literal text after
 *      the call, so an invisible call site silently leaves the population.
 *      Today's population is 0 of this shape — the arm exists to keep it there.
 *      (Found by Vera's hold on #1923, which demonstrated the escape: hoisting
 *      `wakePolicy`'s options into a variable left the two arms above 3/3 green
 *      while reinstating the exact 7.0.11-without-downloadDir defect.)
 *
 * Earned 2026-09-26 (TASK-149). Measured at `f5fd55bc`: eight files passed a
 * `binary` option; four pinned `7.0.11` and two pinned `7.0.14`, against the
 * harness's `MONGO_BINARY_VERSION = '7.0.14'` — three mongod versions in one
 * run, and the tree's only direct evidence of the split is that two of the
 * three are already sitting in `~/.cache/mongodb-binaries`. That matters
 * because of WHEN the missed version is fetched, not just that it is:
 * `globalSetup` warms the harness binary once, before any worker exists, and
 * assigns `process.env.MONGOMS_DOWNLOAD_DIR` so the per-file `create()` calls
 * inherit it; an explicit `version` option beats the env `MONGOMS_VERSION`, so
 * a mismatched pin misses the warmed binary and reaches `download()` inside the
 * parallel worker phase — the download-lock window globalSetup exists to
 * serialise. No workflow caches a binary (no `MONGOMS`/`mongodb-binaries`
 * reference anywhere under `.github/workflows`; the only `cache:` keys are
 * setup-node's `~/.npm`), so a cold CI runner is the case that exercises it.
 *
 * The rule is deliberately one-directional and literal: this says where the
 * version is declared (one constant), not which version is right. The literal
 * patterns are not spelled out in prose on purpose — this file is inside the
 * scanned tree, so a comment quoting them would redden the guard it explains.
 *
 * The two arms guard DIFFERENT RUNS, because the two precedences are opposite
 * (Vera 74507): `getEnsuredOptions` is `opts.version || defaultVersion` — an
 * explicit version option BEATS the env — so arm 1 is load-bearing on every
 * run, and it is the version agreement that closes the worker-phase lock.
 * `generateOptions` is `resolveConfig(DOWNLOAD_DIR) || ensuredOpts.downloadDir`
 * — the env BEATS the option — so arm 2's `downloadDir` is inert on a normal
 * unit run and must not be read as the thing that closed it. Arm 2 decides a
 * path where the env is absent, and there is one: globalSetup returns early
 * under `INTEGRATION_TEST=true` BEFORE exporting either variable, so on that
 * path a suite resolves purely from its own options — there an explicit
 * `downloadDir` fixes the lock path. (A bare call site gets neither variable on
 * that path and is out of both arms' reach; that is half (b)'s population.)
 */

const fs = require('fs');
const path = require('path');

const TESTS_ROOT = path.resolve(__dirname, '..', '..');
const SCANNED_EXTENSIONS = new Set(['.js', '.ts']);
// A call site that passes options. Bare `create()` has no version to disagree
// about and is out of scope by construction.
const CREATE_WITH_OPTIONS = /MongoMemoryServer\.create\(\s*\{/g;
const QUOTED_VERSION = /version:\s*['"]/;
// A call site must pass its options INLINE. `create(opts)` is invisible to the
// literal scan below, so it is refused rather than parsed.
const CREATE_WITH_VARIABLE = /MongoMemoryServer\.create\(\s*[A-Za-z_$]/g;
// Guards against a vacuous pass: the scan finding nothing, or going blind to a
// shape it cannot see, would otherwise satisfy the arms trivially. The floor is
// the measured population (8: seven suites + `utils/testUtils.js`), because a
// floor below it cannot notice a loss — a hoisted call site took the count from
// 8 to 7 under a floor of 5 and stayed green. If half (b) of TASK-149 removes
// call sites by migrating suites onto `setupMongoDb`, lower this with it: the
// floor is a blindness detector, never a target.
const MIN_EXPECTED_CALL_SITES = 8;
const REGION_MAX = 600;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) {
    return entry.name === 'node_modules' ? [] : walk(full);
  }
  return SCANNED_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
});

// The binary option block is the object literal opened by `create(`'s own `{`
// when the call is inline, and it is still the first `}` that follows for the
// multi-line form — the option that opens it is `binary`, which is always first.
const optionRegion = (text, from) => {
  const end = text.indexOf('}', from);
  const stop = end === -1 ? from + REGION_MAX : Math.min(end + 1, from + REGION_MAX);
  return text.slice(from, stop);
};

describe('mongo binary pin agreement', () => {
  const callSites = [];

  walk(TESTS_ROOT).forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    CREATE_WITH_OPTIONS.lastIndex = 0;
    let match = CREATE_WITH_OPTIONS.exec(text);
    while (match !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      callSites.push({
        file: path.relative(TESTS_ROOT, file),
        line,
        region: optionRegion(text, match.index),
      });
      match = CREATE_WITH_OPTIONS.exec(text);
    }
  });

  it('found the call sites it claims to police', () => {
    expect(callSites.length).toBeGreaterThanOrEqual(MIN_EXPECTED_CALL_SITES);
  });

  it('no call site pins a version as a string literal', () => {
    const offenders = callSites
      .filter((site) => QUOTED_VERSION.test(site.region))
      .map((site) => `${site.file}:${site.line}`);
    expect(offenders).toEqual([]);
  });

  it('every options object passed to a call site also passes downloadDir', () => {
    const offenders = callSites
      .filter((site) => !site.region.includes('downloadDir'))
      .map((site) => `${site.file}:${site.line}`);
    expect(offenders).toEqual([]);
  });

  it('no call site passes its options through a variable', () => {
    const offenders = [];
    walk(TESTS_ROOT).forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      CREATE_WITH_VARIABLE.lastIndex = 0;
      let m = CREATE_WITH_VARIABLE.exec(text);
      while (m !== null) {
        offenders.push(`${path.relative(TESTS_ROOT, file)}:${text.slice(0, m.index).split('\n').length}`);
        m = CREATE_WITH_VARIABLE.exec(text);
      }
    });
    expect(offenders).toEqual([]);
  });
});
