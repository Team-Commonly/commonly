/**
 * windows-microvm-smoke.mjs: boots the opt-in microVM sandbox for real, on a
 * Windows host with WHP, through the CLI's own code (sandbox/microsandbox.js),
 * and checks the boundary from inside the guest.
 *
 * Run by .github/workflows/cli-microsandbox-windows.yml. Every credential here
 * is fake; nothing reaches a model or a Commonly instance.
 *
 * The guest must:
 *   - reach the stand-in provider proxy on its exact port;
 *   - NOT reach a second service on the host's loopback (finding 3 in
 *     docs/plans/microsandbox-windows-spike.md), nor the public internet;
 *   - reach a host MCP server through the bridge's shim, with the turn secret;
 *   - see the workspace read-only, and the pinned Claude Code on its volume.
 */
import { spawn } from 'child_process';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  GUEST_CLAUDE, GUEST_CLAUDE_VERSION, GUEST_HOST, GUEST_TURN_DIR, buildMicrovmRunArgs, ensureGuestClaude,
  ensureMsb, guestClaudeEnv, msbHostEnv, probeWhp, startMicrovmTurn, writeMicrovmTurn,
} from '../src/lib/sandbox/microsandbox.js';

const step = (text) => console.log(`\n== ${text}`);
const fail = (text) => { console.error(`FAIL: ${text}`); process.exitCode = 1; };

const listen = (body) => new Promise((resolve) => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(body); });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

// Runs in the guest: each probe reports what happened, never a credential.
const GUEST_PROBE = `'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const get = (mod, url) => new Promise((resolve) => {
  const req = mod.get(url, { timeout: 5000 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve('status ' + res.statusCode + ' ' + b.slice(0, 40))); });
  req.on('timeout', () => { req.destroy(); resolve('blocked (timeout)'); });
  req.on('error', (e) => resolve('blocked (' + e.code + ')'));
});
const mcp = () => new Promise((resolve) => {
  const config = JSON.parse(readFileSync('${GUEST_TURN_DIR}/mcp.json', 'utf8')).mcpServers.echo;
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; if (out.includes('\\n')) { child.kill(); resolve(out.trim()); } });
  child.on('exit', () => resolve(out.trim() || 'no answer'));
  child.stdin.write('ping\\n');
  setTimeout(() => { child.kill(); resolve(out.trim() || 'no answer (timeout)'); }, 8000);
});
const wrongSecret = () => new Promise((resolve) => {
  const [host, port] = JSON.parse(readFileSync('${GUEST_TURN_DIR}/mcp.json', 'utf8')).mcpServers.echo.env.COMMONLY_MCP_BRIDGE.split(':');
  const socket = net.connect(Number(port), host, () => socket.write('0'.repeat(48) + ' echo\\nping\\n'));
  let out = '';
  socket.on('data', (c) => { out += c; });
  socket.on('error', () => {});
  socket.on('close', () => resolve(out ? 'answered: ' + out.trim() : 'closed, nothing'));
  setTimeout(() => { socket.destroy(); resolve(out ? 'answered: ' + out.trim() : 'nothing (timeout)'); }, 4000);
});
const tryWrite = (path) => { try { writeFileSync(path, 'x'); return 'written'; } catch (e) { return 'refused (' + e.code + ')'; } };
(async () => {
  const report = {};
  report.proxy = await get(http, 'http://${GUEST_HOST}:' + process.argv[2] + '/');
  report.otherHostPort = await get(http, 'http://${GUEST_HOST}:' + process.argv[3] + '/');
  report.publicHttps = await get(https, 'https://example.com/');
  report.mcp = await mcp();
  report.workspaceWrite = tryWrite('/workspace/should-not-exist');
  report.gitHookWrite = tryWrite('/workspace/.git/hooks/pre-commit');
  report.agentsVolumeWrite = tryWrite('/opt/agents/bin/planted');
  report.wrongSecret = await wrongSecret();
  const claude = spawnSync('${GUEST_CLAUDE}', ['--version'], { encoding: 'utf8' });
  report.claude = String(claude.stdout || claude.error?.code || '').trim();
  console.log('PROBE ' + JSON.stringify(report));
})();
`;

const ECHO_SERVER = "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',(c)=>{b+=c;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);process.stdout.write('host-echo:'+l+'\\n');}});";

const main = async () => {
  step('WHP');
  const whp = probeWhp();
  console.log(JSON.stringify(whp));
  if (!whp.available) throw new Error(`this runner has no WHP: ${whp.error}`);

  step('msb, pinned and checksum-verified');
  const root = mkdtempSync(join(tmpdir(), 'commonly-msb-'));
  const msb = await ensureMsb({ root });
  console.log(msb);

  step(`Claude Code ${GUEST_CLAUDE_VERSION} on the agents volume`);
  console.log(JSON.stringify(ensureGuestClaude({ msb, root, log: console.log })));

  step('a fenced turn');
  const scratch = mkdtempSync(join(tmpdir(), 'commonly-mv-smoke-'));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true });
  mkdirSync(home);
  const echo = join(scratch, 'echo-server.js');
  writeFileSync(echo, ECHO_SERVER);

  const proxy = await listen('proxy-ok');
  const other = await listen('loopback-only-service');
  const turn = await startMicrovmTurn({
    proxyPort: proxy.address().port,
    hostMcpConfig: { mcpServers: { echo: { command: process.execPath, args: [echo] } } },
  });
  try {
    await writeMicrovmTurn(turn.turnDir, {
      argv: ['node', `${GUEST_TURN_DIR}/probe.js`, String(proxy.address().port), String(other.address().port)],
      env: guestClaudeEnv({ proxyBaseUrl: `http://127.0.0.1:${proxy.address().port}/`, proxyToken: 'fake-proxy-token' }),
      mcpConfig: turn.mcpConfig,
    });
    writeFileSync(join(turn.turnDir, 'probe.js'), GUEST_PROBE);
    const args = buildMicrovmRunArgs({
      ports: turn.ports, turnDir: turn.turnDir, workspace, home,
    });
    console.log(`msb ${args.join(' ')}`);
    const started = Date.now();
    const out = await new Promise((resolve, reject) => {
      const child = spawn(msb, args, { env: msbHostEnv(process.env), windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => process.stderr.write(c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
    });
    console.log(`exit ${out.code} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const line = out.stdout.split(/\r?\n/).find((l) => l.startsWith('PROBE '));
    if (!line) throw new Error(`no probe report:\n${out.stdout}`);
    const report = JSON.parse(line.slice('PROBE '.length));
    console.log(JSON.stringify(report, null, 2));

    if (!report.proxy.startsWith('status 200 proxy-ok')) fail(`the proxy port was not reachable: ${report.proxy}`);
    if (!report.otherHostPort.startsWith('blocked')) fail(`another host loopback service was reachable: ${report.otherHostPort}`);
    if (!report.publicHttps.startsWith('blocked')) fail(`the public internet was reachable: ${report.publicHttps}`);
    if (report.mcp !== 'host-echo:ping') fail(`the MCP bridge did not answer: ${report.mcp}`);
    if (!report.workspaceWrite.startsWith('refused')) fail(`the read-only workspace took a write: ${report.workspaceWrite}`);
    if (!report.gitHookWrite.startsWith('refused')) fail(`the guest could write a git hook: ${report.gitHookWrite}`);
    if (!report.agentsVolumeWrite.startsWith('refused')) fail(`a turn could write the agents volume: ${report.agentsVolumeWrite}`);
    if (report.wrongSecret.startsWith('answered')) fail(`the bridge answered a wrong secret: ${report.wrongSecret}`);
    if (!report.claude.includes(GUEST_CLAUDE_VERSION)) fail(`Claude Code ${GUEST_CLAUDE_VERSION} is not on the volume: ${report.claude}`);
  } finally {
    await turn.close();
    proxy.close();
    other.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!process.exitCode) console.log('\nOK: the microVM held its fence');
};

main().catch((error) => { console.error(error); process.exit(1); });
