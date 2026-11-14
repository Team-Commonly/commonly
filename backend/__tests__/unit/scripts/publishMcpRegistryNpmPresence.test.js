/**
 * Guards the npm presence check in scripts/publish-mcp-registry.sh (F119).
 *
 * On 11-04 (the run of af78f080) the npm readback step read
 * @commonlyai/mcp's new version live, and nine seconds later this script's
 * `npm view` said the version was not on npm. The MCP Registry stayed one
 * version behind until the job was re-run by hand. `npm view` reads the
 * packument, which the CDN caches for up to 300 s (TASK-115 measured this for
 * the readback). The version document is not cached that way.
 *
 * So the check now reads `<registry>/<pkg>/<version>`, requires an exact 200
 * with a body naming this version, and retries. These tests run the script
 * with stub `curl` and `uname` on PATH:
 *   - a version that appears on the third read passes the check;
 *   - one that never appears fails, naming the tries and the last status;
 *   - a 200 whose body names another version is not "on npm";
 *   - `npm` is never called, so the cached path can't come back.
 *
 * The stub `uname` reports a Mac, so a run that passes the presence check
 * stops at the script's next guard (the pinned publisher is linux_amd64) and
 * never downloads or runs the publisher.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'publish-mcp-registry.sh');
const MCP_PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'commonly-mcp', 'package.json'), 'utf8'));

// Answers by URL. The MCP Registry entry is always unlisted (404), so the
// script goes on to the npm check. The npm version document 404s for the
// first STUB_NPM_FAILS reads, then serves {"version": STUB_NPM_VERSION}.
const curlStub = [
  '#!/usr/bin/env bash',
  'out=""; fmt=""; url=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -o) out="$2"; shift 2 ;;',
  '    -w) fmt="$2"; shift 2 ;;',
  '    -m) shift 2 ;;',
  '    -*) shift ;;',
  '    *) url="$1"; shift ;;',
  '  esac',
  'done',
  'printf \'%s\\n\' "$url" >> "$STUB_DIR/curl.calls"',
  'case "$url" in',
  '  *registry.modelcontextprotocol.io*) printf 404; exit 0 ;;',
  '  "$MCP_NPM_REGISTRY_URL"/*)',
  '    n=$(( $(cat "$STUB_DIR/npm.count" 2>/dev/null || echo 0) + 1 ))',
  '    echo "$n" > "$STUB_DIR/npm.count"',
  '    if [ "$n" -le "$STUB_NPM_FAILS" ]; then printf 404; exit 0; fi',
  '    printf \'{"version":"%s"}\' "$STUB_NPM_VERSION" > "$out"',
  '    printf 200; exit 0 ;;',
  'esac',
  'echo "stub curl: unexpected url $url" >&2; exit 1',
  '',
].join('\n');

const unameStub = [
  '#!/usr/bin/env bash',
  'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac',
  '',
].join('\n');

const npmStub = [
  '#!/usr/bin/env bash',
  'echo "$*" >> "$STUB_DIR/npm.calls"',
  'exit 1',
  '',
].join('\n');

describe('publish-mcp-registry.sh npm presence check (F119)', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-registry-presence-'));
    [['curl', curlStub], ['uname', unameStub], ['npm', npmStub]].forEach(([name, body]) => {
      fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
    });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (env) => {
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        STUB_DIR: dir,
        MCP_NPM_REGISTRY_URL: 'https://npm.example.test',
        NPM_PRESENCE_TRIES: '3',
        NPM_PRESENCE_SLEEP_S: '0',
        STUB_NPM_VERSION: MCP_PKG.version,
        STUB_NPM_FAILS: '0',
        ...env,
      },
    });
    const npmReads = Number(fs.existsSync(path.join(dir, 'npm.count'))
      ? fs.readFileSync(path.join(dir, 'npm.count'), 'utf8') : 0);
    return { ...result, out: `${result.stdout}${result.stderr}`, npmReads };
  };

  it('passes once the version document appears, after retrying', () => {
    const result = run({ STUB_NPM_FAILS: '2' });
    expect(result.npmReads).toBe(3);
    expect(result.out).toContain(`npm has no ${MCP_PKG.name}@${MCP_PKG.version} yet (HTTP 404, try 1/3)`);
    // Past the presence check: it stops at the next guard, never at npm.
    expect(result.out).toContain('the pinned mcp-publisher is linux_amd64');
    expect(result.out).not.toContain('is not on npm');
    expect(result.status).toBe(1);
  });

  it('fails after the last try, naming the tries and the last status', () => {
    const result = run({ STUB_NPM_FAILS: '99' });
    expect(result.npmReads).toBe(3);
    expect(result.out).toContain(`${MCP_PKG.name}@${MCP_PKG.version} is not on npm after 3 tries (last HTTP 404)`);
    expect(result.out).not.toContain('linux_amd64');
    expect(result.status).toBe(1);
  });

  it('a 200 for another version is not this version on npm', () => {
    const result = run({ STUB_NPM_VERSION: '0.0.1-other' });
    expect(result.out).toContain('answered 200 for');
    expect(result.out).toContain("with version '0.0.1-other' (try 3/3)");
    expect(result.out).toContain('is not on npm after 3 tries (last HTTP 200)');
  });

  it('reads the uncached version document and never calls npm view', () => {
    run({});
    const urls = fs.readFileSync(path.join(dir, 'curl.calls'), 'utf8').trim().split('\n');
    expect(urls).toContain(`https://npm.example.test/${MCP_PKG.name}/${MCP_PKG.version}`);
    expect(fs.existsSync(path.join(dir, 'npm.calls'))).toBe(false);
  });
});
