#!/usr/bin/env node
/**
 * The Bring your own page's Windows MCP path, run on a real Windows host (the
 * windows-latest job in .github/workflows/mcp-windows.yml). The page tells a
 * Windows user to run, in PowerShell:
 *
 *   npm i -g @commonlyai/mcp
 *   claude mcp add commonly -e COMMONLY_API_URL=... -e COMMONLY_AGENT_TOKEN=... -- cmd /c commonly-mcp
 *
 * Claude Code then starts `cmd /c commonly-mcp` with those two variables and
 * speaks MCP over its stdio. This script does the same thing Claude Code does:
 * it installs the package globally, starts `cmd /c commonly-mcp` against a stub
 * Commonly API, sends initialize and tools/list, and checks the server's
 * start-up call reached the API with the token. It runs twice:
 *   published  - `npm i -g @commonlyai/mcp`, exactly the page's line
 *   this tree  - this checkout's commonly-mcp, so a PR that breaks Windows fails
 *
 * It installs global packages into the runner's profile. Never run it on a
 * machine you use.
 */
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'cm_agent_windows_mcp_smoke';

if (process.platform !== 'win32') {
  console.error('windows-mcp-smoke: Windows only.');
  process.exit(2);
}
if (!process.env.CI) {
  console.error('windows-mcp-smoke: refuses to run outside CI (it installs global npm packages).');
  process.exit(2);
}

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
let failed = false;
const fail = (line) => { console.error(`FAIL: ${line}`); failed = true; };

// The stub API: answers the start-up call and records who made it.
const seen = [];
const server = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/agents/runtime/installations')) {
    res.end(JSON.stringify({ installations: [] }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
const API = `http://127.0.0.1:${server.address().port}`;
log(`stub API on ${API}`);

// npm is itself a .cmd on Windows; a fixed command line through cmd is how a
// PowerShell user runs it too.
const npm = (args) => {
  // Verbatim, the way Node's own shell:true builds it: otherwise Node escapes the
  // quotes around a path as \" and npm reads them as part of the path (seen on
  // windows-latest, 11-04).
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"npm ${args}"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  if (r.status !== 0) throw new Error(`npm ${args} exited ${r.status}: ${(r.stderr || '').slice(-2000)}`);
  return r.stdout;
};

// One MCP session over stdio, started the way Claude Code starts the page's entry.
const session = (label) => new Promise((done) => {
  const child = spawn('cmd', ['/c', 'commonly-mcp'], {
    env: { ...process.env, COMMONLY_API_URL: API, COMMONLY_AGENT_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  const replies = new Map();
  child.stdout.on('data', (chunk) => {
    out += chunk.toString('utf8');
    let nl;
    while ((nl = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) replies.set(msg.id, msg);
      } catch {
        fail(`${label}: stdout carried a line that is not JSON-RPC: ${line.slice(0, 200)}`);
      }
    }
  });
  child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const waitFor = async (id, ms) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (replies.has(id)) return replies.get(id);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 100); });
    }
    return null;
  };
  const stop = () => spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
  (async () => {
    const before = seen.length;
    // Claude Code allows a server 30 s to start; ask for less.
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'windows-mcp-smoke', version: '0' } },
    });
    const init = await waitFor(1, 25_000);
    if (!init?.result?.serverInfo) {
      fail(`${label}: no initialize answer within 25 s. stderr: ${err.slice(-1500)}`);
      stop();
      done();
      return;
    }
    log(`${label}: initialize answered by ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await waitFor(2, 15_000);
    const names = (list?.result?.tools || []).map((t) => t.name);
    if (!names.includes('commonly_post_message')) fail(`${label}: tools/list has no commonly_post_message (${names.length} tools)`);
    else log(`${label}: tools/list lists ${names.length} tools, commonly_post_message among them`);
    // The start-up call (TASK-345) reaches the API with the page's token.
    const start = Date.now();
    while (Date.now() - start < 12_000 && !seen.slice(before).some((s) => s.url.startsWith('/api/agents/runtime/installations'))) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 200); });
    }
    const call = seen.slice(before).find((s) => s.url.startsWith('/api/agents/runtime/installations'));
    if (!call) fail(`${label}: the server never called Commonly at start. stderr: ${err.slice(-1500)}`);
    else if (call.auth !== `Bearer ${TOKEN}`) fail(`${label}: the start-up call did not carry the token`);
    else log(`${label}: start-up call reached the API with the token`);
    stop();
    done();
  })();
});

try {
  log('published: npm i -g @commonlyai/mcp');
  npm('i -g @commonlyai/mcp');
  await session('published');

  const tree = resolve(HERE, '..');
  log(`this tree: npm i -g --install-links ${tree}`);
  npm(`i -g --install-links "${tree}"`);
  await session('this tree');
} catch (error) {
  fail(error.message);
} finally {
  try { npm('rm -g @commonlyai/mcp'); } catch { /* best effort */ }
  server.close();
}
if (!failed) log('PASS');
process.exit(failed ? 1 : 0);
