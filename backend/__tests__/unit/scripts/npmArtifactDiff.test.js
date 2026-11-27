/**
 * Guards scripts/npm-artifact-diff.sh, which decides whether main holds
 * anything npm does not (TASK-466). npm-publish.yml reads exit 1 as permission
 * to publish, so exit 1 must mean ONLY "compared, and the files differ". A review
 * HOLD on #2610 reproduced the opposite: a failing prepublishOnly and a diff
 * I/O error both came out as 1, and the decision step published on a
 * comparison that never finished. Every failure before the verdict is a 2.
 *
 * `npm`, `diff` and `mktemp` are stubs on PATH, driven by env, so each case
 * states the condition rather than mocking the script. `tar` and `node` are real.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'npm-artifact-diff.sh');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'npm-publish.yml');
const GUARD = path.join(REPO_ROOT, '.github', 'workflows', 'package-version-guard.yml');
const REAL_MKTEMP = fs.existsSync('/usr/bin/mktemp') ? '/usr/bin/mktemp' : 'mktemp';
const REAL_DIFF = fs.existsSync('/usr/bin/diff') ? '/usr/bin/diff' : 'diff';

// `npm pack` from the package dir packs it; `npm pack <name>@<v>` "fetches" the
// registry fixture. Either can be made to fail, as can `npm run`.
const npmStub = [
  '#!/usr/bin/env bash',
  'if [ "$1" = run ]; then [ -n "${STUB_PREPUBLISH_FAIL:-}" ] && exit 1; exit 0; fi',
  'if [ "$1" != pack ]; then echo "stub: unexpected npm $*" >&2; exit 1; fi',
  'dest=""; spec=""; shift',
  'while [ $# -gt 0 ]; do case "$1" in --pack-destination) dest="$2"; shift 2;; --silent) shift;; *) spec="$1"; shift;; esac; done',
  'if [ -z "$spec" ]; then [ -n "${STUB_PACK_FAIL:-}" ] && exit 1; src="$PWD"',
  'else [ -n "${STUB_FETCH_FAIL:-}" ] && exit 1',
  // STUB_FETCH_FAIL_TIMES=N: the first N fetches fail (a version npm does not serve yet).
  '  if [ -n "${STUB_FETCH_FAIL_TIMES:-}" ]; then n=$(( $(cat "$STUB_REGISTRY_DIR.count" 2>/dev/null || echo 0) + 1 ))',
  // STUB_FETCH_PARTIAL: a failed fetch leaves a broken partial-<n>.tgz behind, as an
  // interrupted download can.
  '    echo "$n" > "$STUB_REGISTRY_DIR.count"',
  '    if [ "$n" -le "$STUB_FETCH_FAIL_TIMES" ]; then',
  '      [ -n "${STUB_FETCH_PARTIAL:-}" ] && echo partial > "$dest/partial-$n.tgz"',
  '      exit 1',
  '    fi',
  '  fi',
  '  src="$STUB_REGISTRY_DIR"; fi',
  't=$(mktemp -d); mkdir "$t/package"; cp -R "$src"/. "$t/package/"',
  'tar -czf "$dest/pkg.tgz" -C "$t" package',
].join('\n');

const diffStub = [
  '#!/usr/bin/env bash',
  '[ -n "${STUB_DIFF_EXIT:-}" ] && exit "$STUB_DIFF_EXIT"',
  `exec ${REAL_DIFF} "$@"`,
].join('\n');

// STUB_DIFF_OUT_BLOCKED makes diff.txt unopenable (a directory) before the
// script writes it, so its redirect fails without diff ever running.
const mktempStub = [
  '#!/usr/bin/env bash',
  `d=$(${REAL_MKTEMP} "$@") || exit $?`,
  '[ -n "${STUB_DIFF_OUT_BLOCKED:-}" ] && mkdir "$d/diff.txt"',
  'echo "$d"',
].join('\n');

function setup({ localVersion = '0.1.4', registryVersion = '0.1.3', registryText = 'same\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-artifact-diff-'));
  const bin = path.join(root, 'bin');
  const pkg = path.join(root, 'pkg');
  const reg = path.join(root, 'reg');
  for (const d of [bin, pkg, reg]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'npm'), npmStub, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'diff'), diffStub, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'mktemp'), mktempStub, { mode: 0o755 });
  const manifest = (version) => JSON.stringify({ name: '@x/fixture', version }, null, 2);
  fs.writeFileSync(path.join(pkg, 'package.json'), manifest(localVersion));
  fs.writeFileSync(path.join(pkg, 'index.js'), 'same\n');
  fs.writeFileSync(path.join(reg, 'package.json'), manifest(registryVersion));
  fs.writeFileSync(path.join(reg, 'index.js'), registryText);
  return { root, bin, pkg, reg };
}

function run(fx, env = {}) {
  const r = spawnSync('bash', [SCRIPT, fx.pkg, '0.1.3'], {
    encoding: 'utf8',
    // No real waiting between fetch attempts in tests.
    env: {
      ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, STUB_REGISTRY_DIR: fx.reg, NPM_FETCH_RETRY_DELAY: '0', ...env,
    },
  });
  r.fetches = Number(fs.existsSync(`${fx.reg}.count`) ? fs.readFileSync(`${fx.reg}.count`, 'utf8') : 0);
  fs.rmSync(fx.root, { recursive: true, force: true });
  return r;
}

describe('npm-artifact-diff.sh', () => {
  test('identical files apart from the version exit 0', () => {
    expect(run(setup()).status).toBe(0);
  });

  test('a real difference exits 1 and names the file', () => {
    const r = run(setup({ registryText: 'other\n' }));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/index\.js/);
  });

  test.each([
    ['prepublishOnly fails', { STUB_PREPUBLISH_FAIL: '1' }],
    ['local npm pack fails', { STUB_PACK_FAIL: '1' }],
    ['the registry tarball cannot be fetched', { STUB_FETCH_FAIL: '1' }],
    ['diff hits an I/O error (exit 2)', { STUB_DIFF_EXIT: '2' }],
    ['diff exits with anything else', { STUB_DIFF_EXIT: '3' }],
    // The redirect failing returns 1 without diff.
    ['the diff output cannot be opened', { STUB_DIFF_OUT_BLOCKED: '1' }],
  ])('%s: exit 2, never 1', (_label, env) => {
    expect(run(setup(), env).status).toBe(2);
  });

  // The guard runs right after a publish, before npm serves the new version
  // (main went red twice on 11-26, once per cli publish). A fetch that fails
  // is retried; only a version still missing after every attempt is a 2.
  test('a version npm serves only after a few tries is fetched, not a 2', () => {
    const r = run(setup(), { STUB_FETCH_FAIL_TIMES: '2' });
    expect(r.status).toBe(0);
    expect(r.fetches).toBe(3);
  });

  // A failed attempt's leftover file would sit beside the good tarball, and
  // extracting `tgz-registry/*.tgz` would then read the broken one.
  test('a failed fetch that leaves a partial tarball is cleared before the retry', () => {
    const r = run(setup(), { STUB_FETCH_FAIL_TIMES: '2', STUB_FETCH_PARTIAL: '1' });
    expect(r.status).toBe(0);
    expect(r.fetches).toBe(3);
  });

  test('a version still missing after every attempt exits 2, after exactly that many tries', () => {
    const r = run(setup(), { STUB_FETCH_FAIL_TIMES: '99', NPM_FETCH_ATTEMPTS: '4' });
    expect(r.status).toBe(2);
    expect(r.fetches).toBe(4);
    expect(r.stdout).toMatch(/could not fetch @x\/fixture@0\.1\.3 from npm after 4 attempts/);
  });

  // A bad setting must fail at once, not loop: `[ -ge ]` on a non-number
  // errors, which would keep the retry loop from ever reaching its last try.
  test.each([
    ['attempts', { NPM_FETCH_ATTEMPTS: 'ten' }],
    ['attempts zero', { NPM_FETCH_ATTEMPTS: '0' }],
    ['delay', { NPM_FETCH_RETRY_DELAY: '30s' }],
  ])('a non-numeric retry %s setting exits 2 before any fetch', (_label, env) => {
    const r = run(setup(), { STUB_FETCH_FAIL_TIMES: '99', ...env });
    expect(r.status).toBe(2);
    expect(r.fetches).toBe(0);
  });

  test('missing arguments are a 2, not a difference', () => {
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('npm-publish.yml decision step', () => {
  const body = () => fs.readFileSync(WORKFLOW, 'utf8');

  test('only a completed difference (1) may continue to publish', () => {
    const step = body();
    expect(step).toMatch(/0\) echo "version=\$reg_v"/);
    expect(step).toMatch(/\n\s+1\) ;;\n/);
    expect(step).toMatch(/\*\) echo "::error::\$name: could not compare/);
  });

  test('only a confirmed-absent tag (ls-remote exit 2) may publish', () => {
    const step = body();
    expect(step).toMatch(/git ls-remote --exit-code --tags origin "refs\/tags\/\$TAG_PREFIX\$next" >\/dev\/null; t=\$\?/);
    expect(step).toMatch(/case "\$t" in\n\s+2\) ;;/);
    expect(step).toMatch(/could not read tag/);
  });

  test('the stamp step also runs on the already-published path, for the registry retry', () => {
    const step = body();
    expect(step).toContain("if: steps.cmp.outputs.version != ''");
    expect(step).toContain('VERSION: ${{ steps.cmp.outputs.version }}');
  });

  test('an already-published version missing its tag is retagged, not skipped', () => {
    const step = body();
    expect(step).toMatch(/git ls-remote --exit-code --tags origin "refs\/tags\/\$TAG_PREFIX\$reg_v" >\/dev\/null; t=\$\?/);
    expect(step).toContain('echo "action=retag" >> "$GITHUB_OUTPUT"');
    expect(step).toMatch(/could not read tag \$TAG_PREFIX\$reg_v/);
    // The tag and assert steps run on a retag and name the published version.
    expect(step).toContain("if: steps.cmp.outputs.action == 'publish' || steps.cmp.outputs.action == 'retag'");
    expect(step).toContain('TAG: ${{ env.TAG_PREFIX }}${{ steps.cmp.outputs.version }}');
  });

  test('a missing tag is retagged even when no tag with that prefix exists yet', () => {
    // "no tags at all" is also the state after the
    // first publish whose tag push failed, so it must not mean "skip".
    const step = body();
    expect(step).toMatch(/case "\$t" in\n\s+0\) echo "action=skip" >> "\$GITHUB_OUTPUT" ;;\n(\s+#.*\n)*\s+2\) echo "· \$name: \$reg_v is published but/);
    expect(step).not.toContain('git ls-remote --tags origin "refs/tags/$TAG_PREFIX*"');
  });

  test('publishes and tags only from main', () => {
    expect(body()).toContain('if [ "$GITHUB_REF" != "refs/heads/main" ]; then');
  });
});

describe('package-version-guard.yml', () => {
  const body = () => fs.readFileSync(GUARD, 'utf8');

  test('only the pinned last pre-TASK-466 version may be untagged', () => {
    const guard = body();
    expect(guard).toContain('untagged: 0.1.155');
    expect(guard).toContain('untagged: 0.3.16');
    expect(guard).toContain('if [ "$reg_v" = "$UNTAGGED" ]; then');
    expect(guard).not.toContain('git tag --list "$PREFIX*"');
  });
});
