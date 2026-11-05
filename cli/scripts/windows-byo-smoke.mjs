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
 * With COMMONLY_BYO_TARGET=prod it walks the published CLI against the live
 * API with a real model instead, and a person posts the @mention: see
 * windows-byo-prod.mjs.
 *
 * COMMONLY_BYO_HARNESS=codex walks the page's Codex lines instead (D250): the
 * same four lines with `--adapter codex` and no `--unsandboxed`. A public
 * Codex seat cannot run on native Windows (codex-cli 0.162.1's sandbox there
 * refuses its read denies, byo-windows run 41960954496), so `agent run` stops
 * before it polls and points at WSL 2 (cli/src/lib/sandbox/host-check.js).
 * This leg passes when that stop happens: the directions printed, a non-zero
 * exit, and no poll. Codex is the real one, installed from npm by the
 * workflow, and a stub Responses API is named by CODEX_API_KEY beside
 * OPENAI_BASE_URL, so a CLI that polled anyway would be seen reaching it.
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

import { runProdWalk } from './windows-byo-prod.mjs';
import {
  codexRouteEnv, expectsWindowsRefusal, HARNESS_LABELS, installExitFrom, pasteScript, publishedOutcome, walkHarness,
  windowsProdRefusal, windowsRefusalProblems,
} from './windows-byo-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'cm_agent_windows_byo_smoke';
const AGENT = 'win-byo';
const POD = '6a0000000000000000000164';
let HARNESS;
try {
  HARNESS = walkHarness(process.env);
} catch (err) {
  console.error(`windows-byo-smoke: ${err.message}`);
  process.exit(1);
}
const LABEL = HARNESS_LABELS[HARNESS];
const EXPECT_REFUSAL = expectsWindowsRefusal(HARNESS);
const REPLY = `Hello from ${LABEL} on Windows (D164 stub model).`;
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
if (process.env.COMMONLY_BYO_TARGET === 'prod') {
  const prodRefusal = windowsProdRefusal(HARNESS);
  if (prodRefusal) {
    console.error(`windows-byo-smoke: ${prodRefusal}`);
    process.exit(1);
  }
  process.exit(await runProdWalk({ pageConnectSnippet, harness: HARNESS }));
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
// Every Messages call gets the same one-line answer, streamed when asked, and
// so does every Responses call (Codex, which always streams).
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
// The Responses stream codex-cli 0.162.1 completes a turn on (measured against
// a stub like this one before it was written here).
const responsesSse = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send('response.created', { response: { id: 'resp_stub' } });
  send('response.output_item.done', {
    item: { type: 'message', role: 'assistant', id: 'msg_stub', content: [{ type: 'output_text', text: REPLY }] },
  });
  send('response.completed', {
    response: {
      id: 'resp_stub',
      usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 },
    },
  });
  res.end();
};
const modelServer = createServer(async (req, res) => {
  const raw = await readBody(req);
  const { pathname } = new URL(req.url, 'http://stub');
  model.paths.push(`${req.method} ${pathname}`);
  if (req.method === 'POST' && pathname.endsWith('/v1/responses')) {
    responsesSse(res);
    return;
  }
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
if (HARNESS === 'claude') {
  for (const dir of ['C:\\Program Files\\ClaudeCode', 'C:\\ProgramData\\ClaudeCode']) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'managed-settings.json'), managed);
  }
}
// Codex is named the stub by the CLI's environment, as a person names a gateway.
const harnessEnv = HARNESS === 'codex' ? codexRouteEnv(MODEL_URL, 'sk-windows-byo-smoke-codex') : {};

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
  const lines = pageConnectSnippet({ os: 'windows', apiUrl: API, token: TOKEN, agentName: AGENT, adapter: HARNESS })
    .split('\n');
  if (lines.length !== 4 || !/^npm i -g \S+$/.test(lines[0])
    || !lines[3].startsWith(`commonly agent run ${AGENT} --adapter ${HARNESS}`)) {
    console.error(`windows-byo-smoke: the page's Windows lines changed shape: ${JSON.stringify(lines)}`);
    process.exit(1);
  }
  if (installLine) lines[0] = installLine;
  const profile = mkdtempSync(join(tmpdir(), 'byo-profile-'));
  leg = { eventId: `evt-${label.replace(/\W+/g, '-')}`, delivered: false, acked: false, posts: [], badAuth: [] };
  const modelBefore = model.paths.length;
  const apiBefore = api.calls.length;
  // The install line is followed by a guard that stops the paste when it fails.
  const script = pasteScript(lines);
  log(`${label}: pasting into PowerShell for ${LABEL}, profile ${profile}:\n  ${script.join('\n  ')}`);

  // A fresh profile is a machine that has never run Commonly or the harness:
  // no token record, no prepared tools, no Claude Code or Codex state.
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script.join('\n')], {
    cwd: profile,
    env: { ...process.env, USERPROFILE: profile, HOME: profile, ...harnessEnv },
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
  // Codex on Windows: the run exiting, or its first poll, settles the leg.
  const settled = EXPECT_REFUSAL
    ? () => exited !== null || leg.delivered
    : () => exited !== null || gaveUp() || (replied() && leg.acked);
  while (Date.now() - start < LEG_TIMEOUT_MS && !settled()) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 1000); });
  }
  const seconds = Math.round((Date.now() - start) / 1000);
  if (exited === null) killTree(child.pid);

  const problems = [];
  if (EXPECT_REFUSAL) {
    problems.push(...windowsRefusalProblems({ out, exited, polled: leg.delivered, seconds }));
  } else {
    if (!leg.delivered) problems.push('the agent never polled for its @mention');
    else if (model.paths.length === modelBefore) problems.push(`${LABEL} never reached the model`);
    if (!replied()) problems.push(`no reply came back to the pod within ${seconds} s`);
    if (!leg.acked) problems.push('the @mention was never acknowledged');
  }
  if (leg.badAuth.length) problems.push(`calls without the page's token: ${leg.badAuth.join(', ')}`);
  if (!EXPECT_REFUSAL && exited !== null && problems.length) problems.push(`PowerShell exited ${exited} before the walk finished`);
  // How far the CLI got, for publishedOutcome's pull-request rule: its poll,
  // or for a run that should stop first, reading its token from the page.
  const reached = EXPECT_REFUSAL
    ? api.calls.slice(apiBefore).includes('GET /api/agents/runtime/installations')
    : leg.delivered;

  const installExit = installExitFrom(out);
  if (problems.length || installExit !== null) {
    // One stream, so the runner's log keeps this in order.
    log(`${label}: the stub Commonly API saw:\n  ${counts(api.calls.slice(apiBefore)) || '(nothing)'}`);
    log(`${label}: the stub model saw:\n  ${counts(model.paths.slice(modelBefore)) || '(nothing)'}`);
    log(`${label}: posts to the pod: ${JSON.stringify(leg.posts).slice(0, 2000)}`);
    log(`${label}: PowerShell output (last 6000 chars):\n${out.slice(-6000)}`);
  } else if (EXPECT_REFUSAL) {
    log(`${label}: stopped with the WSL 2 directions after ${seconds} s (PowerShell exit ${exited}), never polled:\n${out.slice(-2000)}`);
  } else {
    log(`${label}: reply posted and @mention acknowledged after ${seconds} s`);
  }
  return { problems, installExit, delivered: reached };
};

// The published leg is what a person gets today. On a pull request, what the
// published CLI does once it holds the @mention is reported, not failed: a fix
// to the CLI reaches npm only after it merges, so the published leg cannot
// pass on the PR that fixes it, and this tree's leg is the PR's proof. The
// page's install line, and the published CLI getting as far as its @mention,
// fail a PR too: this tree's leg replaces that line, so nothing else proves
// it. Dispatched, both legs must pass. windows-byo-verdict.mjs holds the rule.
const publishedReportsOnly = process.env.COMMONLY_BYO_PUBLISHED_REPORT_ONLY === '1';
const published = publishedOutcome(await walk('published'), { reportOnly: publishedReportsOnly });
published.warn.forEach((problem) => console.log(`::warning::published CLI on Windows: ${problem}`));
published.fail.forEach((problem) => fail(`published: ${problem}`));
const tarball = process.env.COMMONLY_BYO_TREE_TARBALL;
if (tarball) publishedOutcome(await walk('this tree', `npm i -g ${tarball}`)).fail.forEach((problem) => fail(`this tree: ${problem}`));
else fail('this tree: COMMONLY_BYO_TREE_TARBALL is not set, so this checkout was not walked');

apiServer.close();
modelServer.close();
if (failed) process.exit(1);
if (EXPECT_REFUSAL) {
  log(publishedReportsOnly
    ? `this tree's CLI stopped the page's Windows lines for ${LABEL} with the WSL 2 directions`
    : `the page's Windows lines for ${LABEL} stop with the WSL 2 directions, published and from this tree`);
} else {
  log(publishedReportsOnly
    ? `this tree's CLI answered an @mention from the page's Windows lines for ${LABEL}`
    : `the page's Windows lines for ${LABEL} answered an @mention, published and from this tree`);
}
