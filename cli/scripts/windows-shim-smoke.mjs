#!/usr/bin/env node
/**
 * #2141 proof on a real Windows host (a windows-latest CI job): the adapters
 * launch npm-installed CLIs by reading the cmd-shim npm writes and spawning
 * its target with no shell (src/lib/windows-command.js). The unit tests run
 * that resolver against cmd-shim text captured on macOS; this runs it against
 * the shim real npm generates on Windows, and against the real npx.cmd.
 *
 * 1. Writes a throwaway package whose bin `claude-shim-probe` prints its argv
 *    as JSON, and `npm i -g`s it, so npm writes `claude-shim-probe.cmd`.
 * 2. Resolves it with resolveWindowsCommand (PATH from process.env), spawns it
 *    without a shell with an argv a shell would mangle, and checks the argv
 *    arrives exactly, and that no calculator process appeared.
 * 3. Resolves npx the same way and checks `npx --version` exits 0.
 *
 * It installs into the runner's global npm prefix and removes the package
 * afterwards. Never run it on a machine you use.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { resolveWindowsCommand, resolveWindowsCommandWithReason } from '../src/lib/windows-command.js';

if (process.platform !== 'win32') {
  console.error('windows-shim-smoke: Windows only.');
  process.exit(2);
}
if (!process.env.CI) {
  console.error('windows-shim-smoke: refuses to run outside CI (it installs a global npm package).');
  process.exit(2);
}

const BIN = 'claude-shim-probe';
const PROBE_ARGS = ['-p', 'hello & calc.exe "quoted" %PATH%', '--x'];
const CALCULATORS = new Set(['calc.exe', 'calculator.exe', 'calculatorapp.exe', 'win32calc.exe']);

let failures = 0;
const fail = (line) => { failures += 1; console.error(`FAIL: ${line}`); };
const ok = (line) => console.log(`ok: ${line}`);
const env = { ...process.env };

const resolveOrFail = (name) => {
  const result = resolveWindowsCommandWithReason(name, { env });
  if (!result.command) {
    fail(`${name} did not resolve: ${result.reason}`);
    return null;
  }
  console.log(`${name} -> ${result.source} -> ${JSON.stringify([result.command, ...result.args])}`);
  return result;
};

// No shell anywhere in this script, npm included: npm.cmd goes through the
// same resolver (npm's own hand-written launcher shape).
const run = (resolved, args, opts = {}) => spawnSync(resolved.command, [...resolved.args, ...args], {
  encoding: 'utf8', env, windowsHide: true, timeout: 120000, ...opts, shell: false,
});

const calculatorPids = () => {
  const list = spawnSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, shell: false });
  if (list.status !== 0) {
    fail(`tasklist failed: ${list.stderr || list.error?.message}`);
    return new Set();
  }
  const pids = new Set();
  for (const line of String(list.stdout).split(/\r?\n/)) {
    const [image, pid] = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
    if (image && CALCULATORS.has(image.toLowerCase())) pids.add(`${image}:${pid}`);
  }
  return pids;
};

const pkgDir = mkdtempSync(join(tmpdir(), 'commonly-shim-probe-'));
const npm = resolveOrFail('npm');
let installed = false;

try {
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: BIN, version: '1.0.0', private: true, bin: { [BIN]: 'probe.js' },
  }, null, 2));
  writeFileSync(join(pkgDir, 'probe.js'),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n');

  if (npm) {
    // --install-links copies the folder instead of linking it, so the shim's
    // target does not depend on the temp dir surviving.
    const install = run(npm, ['i', '-g', '--install-links', pkgDir]);
    if (install.status !== 0) fail(`npm i -g exited ${install.status}: ${install.stderr || install.error?.message}`);
    else { installed = true; ok(`npm i -g ${BIN}`); }
  }

  const probe = installed ? resolveOrFail(BIN) : null;
  if (probe) {
    if (!/\.cmd$/i.test(probe.source || '')) fail(`expected npm to write ${BIN}.cmd, found ${probe.source}`);
    const plain = resolveWindowsCommand(BIN, { env });
    if (!plain || plain.command !== probe.command) fail('resolveWindowsCommand disagrees with the WithReason form');

    const before = calculatorPids();
    const result = run(probe, PROBE_ARGS);
    if (result.status !== 0) {
      fail(`${BIN} exited ${result.status}: ${result.stderr || result.error?.message}`);
    } else if (result.stdout !== JSON.stringify(PROBE_ARGS)) {
      fail(`argv mismatch\n  sent:     ${JSON.stringify(PROBE_ARGS)}\n  received: ${result.stdout}`);
    } else {
      ok(`argv arrived verbatim: ${result.stdout}`);
    }
    // calc.exe hands off to the Store calculator and exits, so look twice.
    let appeared = [];
    for (const waitMs of [0, 2000]) {
      if (waitMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      appeared = [...calculatorPids()].filter((pid) => !before.has(pid));
      if (appeared.length) break;
    }
    if (appeared.length) fail(`a calculator process appeared: ${appeared.join(', ')}`);
    else ok('no calculator process appeared');
  }

  const npx = resolveOrFail('npx');
  if (npx) {
    const version = run(npx, ['--version']);
    if (version.status !== 0) fail(`npx --version exited ${version.status}: ${version.stderr || version.error?.message}`);
    else ok(`npx --version: ${String(version.stdout).trim()}`);
  }
} finally {
  if (installed && npm) {
    const remove = run(npm, ['rm', '-g', BIN]);
    if (remove.status !== 0) console.error(`warning: npm rm -g ${BIN} exited ${remove.status}`);
  }
  rmSync(pkgDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`windows-shim-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('windows-shim-smoke: pass');
