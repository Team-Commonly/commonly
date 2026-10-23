#!/usr/bin/env node
/** Real macOS permission-profile probe; no provider credentials or model turn. */
import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { startSeatGhBroker } from '../../src/lib/host-gh-broker.js';

const runFile = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'commonly-gh-isolation-'));
const calls = [];
const seat = async (name) => startSeatGhBroker({
  runtimeToken: `cm_agent_${name.repeat(64)}`,
  instanceUrl: 'https://api.example.invalid',
  root,
  fetchImpl: async () => {
    calls.push(name);
    return new Response(JSON.stringify({ callId: name, outcome: 'ok', result: { number: 1 } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  },
});

const profile = (own, featureOn = true) => [
  '-c', 'default_permissions="host_gh_probe"',
  '-c', `permissions.host_gh_probe.filesystem={":minimal"="read","/opt/homebrew"="read",${JSON.stringify(root)}="deny",${JSON.stringify(own.directory)}="read"}`,
  '-c', `features.network_proxy=${featureOn}`,
  '-c', 'permissions.host_gh_probe.network.enabled=true',
  '-c', `permissions.host_gh_probe.network.unix_sockets={${JSON.stringify(own.socketPath)}="allow"}`,
];

const connectProbe = 'const n=require("net");const s=n.connect(process.argv[1]);s.on("connect",()=>{console.log("CONNECTED");s.end()});s.on("error",e=>{console.log(e.code);process.exitCode=2})';
const run = async (profileArgs, command, args = [], env = process.env) => {
  try {
    const result = await runFile('codex', ['sandbox', ...profileArgs, command, ...args], {
      env, timeout: 15000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
};
const expect = (condition, message) => { if (!condition) throw new Error(message); };

let a;
let b;
try {
  a = await seat('A');
  b = await seat('B');
  const aProfile = profile(a);
  const own = await run(aProfile, a.shimPath,
    ['pr', 'view', '1', '--grant-id', 'grant-1'],
    { ...process.env, COMMONLY_GH_SOCKET: a.socketPath });
  expect(own.code === 0 && calls.length === 1 && calls[0] === 'A', `own socket failed: ${own.stderr}`);

  const other = await run(aProfile, process.execPath, ['-e', connectProbe, b.socketPath]);
  expect(other.code === 2 && other.stdout.includes('EPERM') && calls.length === 1,
    `cross-seat socket reached: ${other.stdout} ${other.stderr}`);
  // Mutation control: without the proxy feature, the nominal socket allowlist
  // does not confine direct AF_UNIX connects on this macOS build.
  const unconfined = await run(profile(a, false), process.execPath, ['-e', connectProbe, b.socketPath]);
  expect(unconfined.code === 0 && unconfined.stdout.includes('CONNECTED'),
    `expected the no-proxy control to expose B: ${unconfined.stdout} ${unconfined.stderr}`);

  const oldPath = b.socketPath;
  await b.close();
  b = await seat('B');
  const restarted = await run(aProfile, process.execPath, ['-e', connectProbe, b.socketPath]);
  expect(restarted.code === 2 && restarted.stdout.includes('EPERM') && calls.length === 1,
    `restarted cross-seat socket reached: ${restarted.stdout} ${restarted.stderr}`);
  const stale = await run(aProfile, process.execPath, ['-e', connectProbe, oldPath]);
  expect(stale.code !== 0 && calls.length === 1, 'stale socket remained reachable');

  process.stdout.write('PASS: own call, known sibling, no-proxy control, restarted sibling, stale endpoint\n');
} finally {
  await a?.close();
  await b?.close();
  await rm(root, { recursive: true, force: true });
}
