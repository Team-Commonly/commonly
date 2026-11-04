#!/usr/bin/env node
/**
 * D164: the Bring your own page's Windows lines, walked on a real Windows host
 * (the windows-latest job in .github/workflows/byo-windows.yml). For Claude
 * Code the page tells a Windows visitor to paste four lines into PowerShell:
 *
 *   npm i -g @commonlyai/cli@latest
 *   $env:COMMONLY_API_URL="…"
 *   $env:COMMONLY_AGENT_TOKEN="…"
 *   commonly agent run <name> --adapter claude --unsandboxed
 *
 * This script pastes them into one PowerShell process, as a person does, with
 * a stub Commonly API served from this process and one @mention queued on it.
 * The walk passes when the agent's reply comes back to the pod and the
 * @mention is acknowledged. That is the whole loop the page promises.
 *
 * Claude Code is the real one, installed from npm by the workflow. Only the
 * model is a stub: a Messages API answering from this process. A public seat
 * strips ANTHROPIC_* from Claude Code's environment, so the stub is named in
 * Claude Code's machine-wide managed settings, which every session reads. On
 * a person's machine that is their own sign-in.
 *
 * The lines are read from V2AgentBYO.tsx (connectSnippet), not copied here,
 * so a change to the page's Windows snippet re-runs this job and is what gets
 * walked. Two legs, each in a fresh profile folder:
 *   published  - the page's lines verbatim, so `@latest` from npm
 *   this tree  - the install line names this checkout's packed CLI instead
 *                (COMMONLY_BYO_TREE_TARBALL), so a PR that breaks it fails
 *
 * It installs global packages and writes Claude Code's managed settings.
 * Never run it on a machine you use.
 */
import { spawn, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'cm_agent_windows_byo_smoke';
const AGENT = 'win-byo';
const POD = '6a0000000000000000000164';
const REPLY = 'Hello from Claude Code on Windows (D164 stub model).';
const LEG_TIMEOUT_MS = 8 * 60_000;

// ── the page's lines ──────────────────────────────────────────────────────
// connectSnippet and the two helpers it uses, lifted out of the component
// and run as plain JS. Each piece must be found in the shape read here, or
// the walk stops and says which piece moved.
// A Windows checkout has CRLF line endings (autocrlf); the shapes read LF.
const pageSource = readFileSync(resolve(HERE, '../../frontend/src/v2/components/V2AgentBYO.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');
const lift = (re, what) => {
  const m = re.exec(pageSource);
  if (!m) {
    console.error(`windows-byo-smoke: ${what} not found in V2AgentBYO.tsx in the shape this script reads`);
    process.exit(1);
  }
  return m[0];
};
const pageConnectSnippet = new Function([
  lift(/const CLI_INSTALL_COMMAND = '[^'\n]*';/, 'CLI_INSTALL_COMMAND'),
  lift(/const POWERSHELL_SPECIAL = \/[^\n]*\/g;/, 'POWERSHELL_SPECIAL'),
  lift(/export const powerShellQuote = \(value: string\): string => [^\n]*;/, 'powerShellQuote')
    .replace(/^export /, '').replace('(value: string): string =>', '(value) =>'),
  lift(/export const connectSnippet = \(\{[\s\S]*?\n\};\n/, 'connectSnippet')
    .replace(/^export /, '').replace(/\}: \{[^}]*\}\): string => \{/, '}) => {'),
  'return connectSnippet;',
].join('\n'))();

if (process.platform !== 'win32') {
  console.error('windows-byo-smoke: Windows only.');
  process.exit(2);
}
if (!process.env.CI) {
  console.error('windows-byo-smoke: refuses to run outside CI (it installs global npm packages and writes Claude Code managed settings).');
  process.exit(2);
}

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
let failed = false;
const fail = (line) => { console.log(`::error::${line}`); failed = true; };
const listen = (server) => new Promise((r) => { server.listen(0, '127.0.0.1', () => r(server.address().port)); });
const readBody = (req) => new Promise((r) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => r(raw));
});

// ── the stub model ────────────────────────────────────────────────────────
// Every Messages call gets the same one-line answer, streamed when asked.
const model = { paths: [] };
const sse = (res, modelName) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send('message_start', {
    message: {
      id: 'msg_stub', type: 'message', role: 'assistant', model: modelName, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: REPLY } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', {});
  res.end();
};
const modelServer = createServer(async (req, res) => {
  const raw = await readBody(req);
  const { pathname } = new URL(req.url, 'http://stub');
  model.paths.push(`${req.method} ${pathname}`);
  if (pathname.endsWith('/v1/messages/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}');
    return;
  }
  if (!pathname.endsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' })
      .end('{"type":"error","error":{"type":"not_found_error","message":"stub"}}');
    return;
  }
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch { /* answered anyway */ }
  if (body.stream) {
    sse(res, body.model);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id: 'msg_stub', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: REPLY }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  }));
});
const MODEL_URL = `http://127.0.0.1:${await listen(modelServer)}`;
log(`stub model on ${MODEL_URL}`);

// Claude Code reads managed settings machine-wide, whatever --setting-sources
// says. Both locations: the current one, and the one older releases read.
const managed = JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: MODEL_URL,
    ANTHROPIC_API_KEY: 'sk-ant-windows-byo-smoke',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  },
}, null, 2);
for (const dir of ['C:\\Program Files\\ClaudeCode', 'C:\\ProgramData\\ClaudeCode']) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'managed-settings.json'), managed);
}

// ── the stub Commonly API ─────────────────────────────────────────────────
// What `agent run` calls, from cli/src/commands/agent.js: the token's
// identity, the event poll, the per-turn reads, the reply, the ack. Anything
// else gets `{}`, which every best-effort read accepts.
let leg = null;
const api = { calls: [] };
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};
const apiServer = createServer(async (req, res) => {
  const raw = await readBody(req);
  const { pathname } = new URL(req.url, 'http://stub');
  const auth = req.headers.authorization || '';
  api.calls.push(`${req.method} ${pathname}`);
  if (auth !== `Bearer ${TOKEN}`) {
    if (leg) leg.badAuth.push(`${req.method} ${pathname}`);
    json(res, { error: 'Unauthorized' }, 401);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/agents/runtime/installations') {
    json(res, {
      agentName: AGENT,
      instanceId: 'default',
      installations: [{ type: 'installation', status: 'active', podId: POD, instanceId: 'default' }],
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/agents/runtime/events') {
    if (leg && !leg.delivered) {
      leg.delivered = true;
      json(res, {
        events: [{
          _id: leg.eventId,
          type: 'chat.mention',
          podId: POD,
          payload: { content: `@${AGENT} say hello from Windows` },
        }],
      });
      return;
    }
    json(res, { events: [] });
    return;
  }
  if (req.method === 'GET' && pathname === `/api/agents/runtime/pods/${POD}/context`) {
    json(res, { focus: { podId: POD, revision: 0, focus: null } });
    return;
  }
  if (req.method === 'GET' && pathname === `/api/agents/runtime/pods/${POD}/messages`) {
    json(res, { messages: [] });
    return;
  }
  if (req.method === 'POST' && pathname === `/api/agents/runtime/pods/${POD}/messages`) {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* recorded empty */ }
    if (leg) leg.posts.push(body);
    json(res, { success: true, message: { _id: `m-${Date.now()}`, content: body.content } });
    return;
  }
  if (req.method === 'POST' && leg && pathname === `/api/agents/runtime/events/${leg.eventId}/ack`) {
    leg.acked = true;
    json(res, { success: true });
    return;
  }
  json(res, {});
});
const API = `http://127.0.0.1:${await listen(apiServer)}`;
log(`stub Commonly API on ${API}`);

// ── one leg: the four lines in one PowerShell window ──────────────────────
const killTree = (pid) => spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)]);
const counts = (list) => Object.entries(list.reduce((acc, p) => ({ ...acc, [p]: (acc[p] || 0) + 1 }), {}))
  .map(([p, n]) => `${p} x${n}`).join('\n  ');

const walk = async (label, installLine) => {
  const lines = pageConnectSnippet({ os: 'windows', apiUrl: API, token: TOKEN, agentName: AGENT, adapter: 'claude' })
    .split('\n');
  if (lines.length !== 4 || !/^npm i -g \S+$/.test(lines[0]) || !/^commonly agent run /.test(lines[3])) {
    console.error(`windows-byo-smoke: the page's Windows lines changed shape: ${JSON.stringify(lines)}`);
    process.exit(1);
  }
  if (installLine) lines[0] = installLine;
  const profile = mkdtempSync(join(tmpdir(), 'byo-profile-'));
  leg = { eventId: `evt-${label.replace(/\W+/g, '-')}`, delivered: false, acked: false, posts: [], badAuth: [] };
  const modelBefore = model.paths.length;
  const apiBefore = api.calls.length;
  log(`${label}: pasting into PowerShell, profile ${profile}:\n  ${lines.join('\n  ')}`);

  // A fresh profile is a machine that has never run Commonly or Claude Code:
  // no token record, no prepared tools, no Claude Code state.
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lines.join('\n')], {
    cwd: profile,
    env: { ...process.env, USERPROFILE: profile, HOME: profile },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString('utf8'); });
  child.stderr.on('data', (c) => { out += c.toString('utf8'); });
  let exited = null;
  child.on('close', (code) => { exited = code; });

  const start = Date.now();
  const replied = () => leg.posts.some((p) => String(p.content || '').includes(REPLY));
  // After three refused turns the CLI opens its circuit and hands the event
  // back for a requeue 10 to 20 minutes out; nothing more happens in a leg.
  const gaveUp = () => /circuit open; releasing/.test(out);
  while (Date.now() - start < LEG_TIMEOUT_MS && exited === null && !gaveUp() && !(replied() && leg.acked)) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 1000); });
  }
  const seconds = Math.round((Date.now() - start) / 1000);
  if (exited === null) killTree(child.pid);

  const problems = [];
  if (!leg.delivered) problems.push('the agent never polled for its @mention');
  else if (model.paths.length === modelBefore) problems.push('Claude Code never reached the model');
  if (!replied()) problems.push(`no reply came back to the pod within ${seconds} s`);
  if (!leg.acked) problems.push('the @mention was never acknowledged');
  if (leg.badAuth.length) problems.push(`calls without the page's token: ${leg.badAuth.join(', ')}`);
  if (exited !== null && problems.length) problems.push(`PowerShell exited ${exited} before the walk finished`);

  if (problems.length) {
    // One stream, so the runner's log keeps this in order.
    log(`${label}: the stub Commonly API saw:\n  ${counts(api.calls.slice(apiBefore)) || '(nothing)'}`);
    log(`${label}: the stub model saw:\n  ${counts(model.paths.slice(modelBefore)) || '(nothing)'}`);
    log(`${label}: posts to the pod: ${JSON.stringify(leg.posts).slice(0, 2000)}`);
    log(`${label}: PowerShell output (last 6000 chars):\n${out.slice(-6000)}`);
  } else {
    log(`${label}: reply posted and @mention acknowledged after ${seconds} s`);
  }
  return problems;
};

// The published leg is what a person gets today. On a pull request it is
// reported, not failed: a fix to the CLI reaches npm only after it merges, so
// the published leg cannot pass on the PR that fixes it. This tree's leg is
// the PR's proof. Dispatched, both legs must pass.
const publishedReportsOnly = process.env.COMMONLY_BYO_PUBLISHED_REPORT_ONLY === '1';
for (const problem of await walk('published')) {
  if (publishedReportsOnly) console.log(`::warning::published CLI on Windows: ${problem}`);
  else fail(`published: ${problem}`);
}
const tarball = process.env.COMMONLY_BYO_TREE_TARBALL;
if (tarball) (await walk('this tree', `npm i -g ${tarball}`)).forEach((problem) => fail(`this tree: ${problem}`));
else fail('this tree: COMMONLY_BYO_TREE_TARBALL is not set, so this checkout was not walked');

apiServer.close();
modelServer.close();
if (failed) process.exit(1);
log(publishedReportsOnly
  ? 'this tree\'s CLI answered an @mention from the page\'s Windows lines'
  : 'the page\'s Windows lines answered an @mention, published and from this tree');
