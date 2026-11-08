#!/usr/bin/env node
/**
 * The Bring your own page's Windows MCP path, run on a real Windows host (the
 * windows-latest job in .github/workflows/mcp-windows.yml). The page tells a
 * Windows user to run, in PowerShell:
 *
 *   npm i -g @commonlyai/mcp
 *   claude mcp add commonly cmd /c commonly-mcp -e COMMONLY_API_URL=... -e COMMONLY_AGENT_TOKEN=...
 *
 * Claude Code then starts `cmd /c commonly-mcp` with those two variables and
 * speaks MCP over its stdio. This script does the same thing Claude Code does:
 * it installs the package globally, starts `cmd /c commonly-mcp` against a stub
 * Commonly API, sends initialize and tools/list, and checks the server's
 * start-up call reached the API with the token. It runs three times:
 *   published   - `npm i -g @commonlyai/mcp`, exactly the page's line
 *   this tree   - this checkout's commonly-mcp, so a PR that breaks Windows fails
 *   Claude Code - the page's own `claude mcp add` line, run in PowerShell, then
 *                 `claude mcp list`, which launches the server the way a
 *                 session does and prints Connected or Failed (F106)
 *
 * The two lines are read from V2AgentBYO.tsx, not copied here, so a change to
 * the page's Windows snippet re-runs this job and is what gets tested.
 *
 * It installs global packages into the runner's profile. Never run it on a
 * machine you use.
 */
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'cm_agent_windows_mcp_smoke';
// The pinned Claude Code release, unless the workflow's @latest leg names
// another (F107): a Claude Code parser change that stops reading the page's
// line shows up there before a person meets it.
const CLAUDE_CODE_PINNED = '2.1.318';
const claudeCodeVersion = process.env.COMMONLY_SMOKE_CLAUDE_CODE || CLAUDE_CODE_PINNED;
if (!/^(latest|\d+\.\d+\.\d+)$/.test(claudeCodeVersion)) {
  console.error(`windows-mcp-smoke: COMMONLY_SMOKE_CLAUDE_CODE must be latest or x.y.z, not ${JSON.stringify(claudeCodeVersion)}`);
  process.exit(2);
}
const CLAUDE_CODE = `@anthropic-ai/claude-code@${claudeCodeVersion}`;
// How long a PowerShell line may hold its pipes open after it exits. A child it
// started (a server Claude Code left running) can keep stdout open, and
// waiting on 'close' then hung the job to its 15-minute timeout (F107).
const PIPE_GRACE_MS = 5_000;

// The page's Windows snippet, from the component that renders it. The source
// holds `\n` escapes inside a template literal, so the lines split on those.
const pageSource = readFileSync(resolve(HERE, '../../frontend/src/v2/components/V2AgentBYO.tsx'), 'utf8');
const snippet = /const claudeSnippetWindows = issued\s*\?\s*`([^`]*)`/.exec(pageSource);
if (!snippet) {
  console.error('windows-mcp-smoke: claudeSnippetWindows not found in V2AgentBYO.tsx');
  process.exit(1);
}
const [installLine, addLine, ...rest] = snippet[1].split('\\n');
if (rest.length || !/^npm i -g \S+$/.test(installLine || '') || !/^claude mcp add /.test(addLine || '')) {
  console.error(`windows-mcp-smoke: the page's Windows snippet changed shape: ${JSON.stringify(snippet[1])}`);
  process.exit(1);
}

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
const pageAdd = addLine.replace('${apiUrl}', API).replace('${issued.token}', TOKEN);
if (pageAdd.includes('${')) {
  console.error(`windows-mcp-smoke: unfilled placeholder in the page's line: ${addLine}`);
  process.exit(1);
}

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

// PowerShell, where the page tells a Windows user to paste its lines. Async,
// so the stub API in this process can answer the server's check-in while
// Claude Code is running it (a spawnSync would hold the event loop).
const powershell = (line, cwd) => new Promise((done) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], {
    cwd,
    env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let grace = null;
  child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const timer = setTimeout(() => {
    stderr += '\n(timed out after 120 s)';
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
  }, 120_000);
  const settle = (status) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(grace);
    done({ status, stdout, stderr });
  };
  // 'close' waits for every holder of the pipes, so settle on 'exit' once the
  // output has had PIPE_GRACE_MS to drain.
  child.on('exit', (status) => { grace = setTimeout(() => settle(status), PIPE_GRACE_MS); });
  child.on('close', (status) => settle(status));
});

// Claude Code itself starts the server from the page's line (the npm .cmd shim
// class, #2141): `claude mcp list` launches each server, initializes it, and
// prints Connected or Failed. The check-in must also reach the API.
const claudeCode = async (label) => {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-smoke-'));
  const before = seen.length;
  log(`Claude Code (${label}): ${addLine}`);
  const add = await powershell(pageAdd, cwd);
  if (add.status !== 0) {
    fail(`Claude Code (${label}): the page's claude mcp add line exited ${add.status}: ${(add.stderr || add.stdout || '').slice(-1500)}`);
    return;
  }
  const list = await powershell('claude mcp list', cwd);
  const out = `${list.stdout || ''}${list.stderr || ''}`;
  if (list.status !== 0) fail(`Claude Code (${label}): claude mcp list exited ${list.status}: ${out.slice(-1500)}`);
  const row = out.split(/\r?\n/).find((l) => /^commonly:/.test(l.trim()));
  log(`Claude Code (${label}): claude mcp list -> ${row ? row.trim() : '(no commonly row)'}`);
  if (!row) fail(`Claude Code (${label}): claude mcp list has no commonly server: ${out.slice(-1500)}`);
  else if (!/Connected/.test(row)) fail(`Claude Code (${label}) could not start the page's server: ${row.trim()}`);
  const call = seen.slice(before).find((s) => s.url.startsWith('/api/agents/runtime/installations'));
  if (!call) fail(`Claude Code (${label}): the server Claude Code started never called Commonly`);
  else if (call.auth !== `Bearer ${TOKEN}`) fail(`Claude Code (${label}): the start-up call did not carry the page's token`);
  else log(`Claude Code (${label}): start-up call reached the API with the token`);
};

try {
  log(`Claude Code: npm i -g ${CLAUDE_CODE}`);
  npm(`i -g ${CLAUDE_CODE}`);
  const installed = await powershell('claude --version', tmpdir());
  log(`Claude Code: ${(installed.stdout || installed.stderr || '').trim() || '(no version printed)'}`);

  log(`published: ${installLine}`);
  npm(installLine.replace(/^npm /, ''));
  await session('published');
  await claudeCode('published');

  const tree = resolve(HERE, '..');
  log(`this tree: npm i -g --install-links ${tree}`);
  npm(`i -g --install-links "${tree}"`);
  await session('this tree');
  await claudeCode('this tree');
} catch (error) {
  fail(error.message);
} finally {
  try { npm(`rm -g @commonlyai/mcp ${CLAUDE_CODE.replace(/@[^@]+$/, '')}`); } catch { /* best effort */ }
  server.close();
}
if (!failed) log('PASS');
process.exit(failed ? 1 : 0);
