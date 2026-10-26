#!/usr/bin/env node
/**
 * Probe what a `network: 'loopback'` Seatbelt profile actually denies, on this
 * Mac, with nothing but node and (when the toolchain is present) a ten-line C
 * program of our own. It is the enforcement half of the confined dsh seat:
 * the adapter tests prove the options, this proves the kernel holds them.
 *
 *   node cli/scripts/probe-seatbelt-confinement.mjs [--json]
 *
 * Every probe only opens, connects or looks up; none reads a file's content,
 * and nothing here calls /usr/bin/security. Exit 0 when every probe matched.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { homedir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';

// Runs inside the profile. Each probe prints one JSON line: { name, ok, code }.
const CHILD = String.raw`
const fs = require('fs');
const net = require('net');
const [workspace, outside, allowedPort, deniedPort, paths] = JSON.parse(process.argv[1]);
const out = (name, ok, code) => process.stdout.write(JSON.stringify({ name, ok, code }) + '\n');
const tryOpen = (name, path) => {
  try { fs.closeSync(fs.openSync(path, 'r')); out(name, true, null); } catch (e) { out(name, false, e.code); }
};
const tryWrite = (name, path) => {
  try { fs.writeFileSync(path, 'probe'); out(name, true, null); } catch (e) { out(name, false, e.code); }
};
const tryConnect = (name, host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: 3000 });
  socket.on('connect', () => { socket.destroy(); out(name, true, null); resolve(); });
  socket.on('timeout', () => { socket.destroy(); out(name, false, 'TIMEOUT'); resolve(); });
  socket.on('error', (e) => { out(name, false, e.code); resolve(); });
});
(async () => {
  tryWrite('write inside the workspace', workspace + '/probe.txt');
  tryWrite('write outside the workspace', outside + '/probe.txt');
  for (const [name, path] of paths) tryOpen(name, path);
  await tryConnect('connect to the allowed loopback port', '127.0.0.1', Number(allowedPort));
  await tryConnect('connect to another loopback port', '127.0.0.1', Number(deniedPort));
  await tryConnect('connect to 1.1.1.1:443', '1.1.1.1', 443);
})();
`;

// bootstrap_look_up only: it asks launchd for a port and never talks to it.
const MACH_LOOKUP_C = `#include <servers/bootstrap.h>
#include <stdio.h>
int main(int argc, char **argv) {
  mach_port_t port;
  kern_return_t kr = bootstrap_look_up(bootstrap_port, argv[1], &port);
  printf("%d\\n", kr);
  return kr == KERN_SUCCESS ? 0 : 1;
}
`;

const listen = () => new Promise((resolve) => {
  const server = createServer((socket) => socket.destroy());
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const compileMachLookup = (dir) => {
  // xcode-select fails without a toolchain; /usr/bin/clang would then offer an
  // install dialog, so it is not run at all.
  if (spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).status !== 0) return null;
  const source = join(dir, 'mach-lookup.c');
  const binary = join(dir, 'mach-lookup');
  writeFileSync(source, MACH_LOOKUP_C);
  const built = spawnSync('/usr/bin/clang', ['-o', binary, source], { encoding: 'utf8' });
  return built.status === 0 ? binary : null;
};

export const probeSeatbeltConfinement = async () => {
  if (process.platform !== 'darwin') throw new Error('the Seatbelt probe runs on macOS only');
  const root = mkdtempSync(join(homedir(), '.commonly-seatbelt-probe-'));
  const workspace = join(root, 'workspace');
  const state = join(root, 'state');
  const outside = join(root, 'outside');
  const tools = join(root, 'tools');
  for (const dir of [workspace, state, outside, tools]) spawnSync('/bin/mkdir', ['-p', dir]);
  const allowed = await listen();
  const denied = await listen();
  const results = [];
  try {
    const machLookup = compileMachLookup(tools);
    const profile = buildSeatbeltProfile({
      workspacePath: workspace,
      workspaceAccess: 'write',
      executablePath: process.execPath,
      statePath: state,
      network: 'loopback',
      loopbackNetworkPorts: [allowed.address().port],
      executablePaths: machLookup ? [machLookup] : [],
    });
    const secretPaths = [
      ['open ~/.commonly', join(homedir(), '.commonly')],
      ['open ~/.config/gh/hosts.yml', join(homedir(), '.config', 'gh', 'hosts.yml')],
      ['open the login keychain file', join(homedir(), 'Library', 'Keychains', 'login.keychain-db')],
    ];
    const child = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', CHILD, JSON.stringify([
      workspace, outside, allowed.address().port, denied.address().port, secretPaths,
    ])], { encoding: 'utf8', timeout: 30_000 });
    const seen = Object.fromEntries(String(child.stdout || '').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).map((entry) => [entry.name, entry]));
    const expect = (name, wantOk, detail = '') => {
      const got = seen[name];
      results.push({
        probe: name, expected: wantOk ? 'allowed' : 'denied',
        got: got ? (got.ok ? 'allowed' : `denied (${got.code})`) : 'no result',
        pass: !!got && got.ok === wantOk && (wantOk || got.code === 'EPERM' || got.code === 'EACCES'),
        detail,
      });
    };
    expect('write inside the workspace', true);
    expect('write outside the workspace', false);
    for (const [name, path] of secretPaths) {
      // A denial of a path that is not there proves less, so say which it was.
      expect(name, false, existsSync(path) ? 'exists on this host' : 'absent on this host');
    }
    expect('connect to the allowed loopback port', true);
    expect('connect to another loopback port', false);
    expect('connect to 1.1.1.1:443', false);

    if (machLookup) {
      const lookup = (service, sandboxed) => {
        const argv = sandboxed ? ['/usr/bin/sandbox-exec', '-p', profile, machLookup, service] : [machLookup, service];
        const run = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 10_000 });
        return Number(String(run.stdout).trim());
      };
      const rows = [
        // Positive controls: the program works, unconfined and for a service the profile admits.
        ['look up com.apple.SecurityServer, unconfined', 'com.apple.SecurityServer', false, true],
        ['look up com.apple.trustd (admitted)', 'com.apple.trustd', true, true],
        ['look up com.apple.SecurityServer', 'com.apple.SecurityServer', true, false],
        ['look up com.apple.securityd', 'com.apple.securityd', true, false],
      ];
      for (const [probe, service, sandboxed, wantOk] of rows) {
        const kr = lookup(service, sandboxed);
        results.push({
          probe, expected: wantOk ? 'allowed' : 'denied',
          got: kr === 0 ? 'allowed' : `denied (kern_return ${kr})`,
          pass: wantOk ? kr === 0 : kr !== 0 && Number.isFinite(kr),
          detail: '',
        });
      }
    } else {
      results.push({ probe: 'mach-lookup probes', expected: 'run', got: 'skipped: no command-line toolchain', pass: true, detail: 'skipped' });
    }
    return { ok: results.every((row) => row.pass), results, stderr: String(child.stderr || '').trim().slice(0, 500) };
  } finally {
    allowed.close();
    denied.close();
    rmSync(root, { recursive: true, force: true });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await probeSeatbeltConfinement();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const row of report.results) {
      process.stdout.write(`${row.pass ? 'ok  ' : 'FAIL'}  ${row.probe}: expected ${row.expected}, got ${row.got}${row.detail ? ` (${row.detail})` : ''}\n`);
    }
    if (report.stderr) process.stdout.write(`child stderr: ${report.stderr}\n`);
  }
  process.exitCode = report.ok ? 0 : 1;
}
