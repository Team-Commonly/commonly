/**
 * Guards scripts/npm-artifact-diff.sh, which decides whether main holds
 * anything npm does not (TASK-466). npm-publish.yml reads exit 1 as permission
 * to publish, so exit 1 must mean ONLY "compared, and the files differ". Sable's
 * HOLD on #2610 reproduced the opposite: a failing prepublishOnly and a diff
 * I/O error both came out as 1, and the decision step published on a
 * comparison that never finished. Every failure before the verdict is a 2.
 *
 * `npm` and `diff` are stubs on PATH, driven by env, so each case states the
 * condition rather than mocking the script. `tar` and `node` are real.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'npm-artifact-diff.sh');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'npm-publish.yml');
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
  'else [ -n "${STUB_FETCH_FAIL:-}" ] && exit 1; src="$STUB_REGISTRY_DIR"; fi',
  't=$(mktemp -d); mkdir "$t/package"; cp -R "$src"/. "$t/package/"',
  'tar -czf "$dest/pkg.tgz" -C "$t" package',
].join('\n');

const diffStub = [
  '#!/usr/bin/env bash',
  '[ -n "${STUB_DIFF_EXIT:-}" ] && exit "$STUB_DIFF_EXIT"',
  `exec ${REAL_DIFF} "$@"`,
].join('\n');

function setup({ localVersion = '0.1.4', registryVersion = '0.1.3', registryText = 'same\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-artifact-diff-'));
  const bin = path.join(root, 'bin');
  const pkg = path.join(root, 'pkg');
  const reg = path.join(root, 'reg');
  for (const d of [bin, pkg, reg]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'npm'), npmStub, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'diff'), diffStub, { mode: 0o755 });
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
    env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, STUB_REGISTRY_DIR: fx.reg, ...env },
  });
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
  ])('%s: exit 2, never 1', (_label, env) => {
    expect(run(setup(), env).status).toBe(2);
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
});
