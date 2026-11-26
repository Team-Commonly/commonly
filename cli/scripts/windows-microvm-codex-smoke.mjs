/**
 * windows-microvm-codex-smoke.mjs: one public Codex turn, end to end, inside
 * the opt-in microVM sandbox, on a Windows host with WHP, through the codex
 * adapter's own spawn (adapters/codex.js) and the CLI's real provider proxy.
 *
 * Run by .github/workflows/cli-microsandbox-windows.yml after the Claude
 * smoke. Every credential here is fake; the "model" is a stub on the runner's
 * loopback that answers on the OpenAI Responses wire and echoes the bearer it
 * received, so the reply shows whether the proxy kept the key out of the VM.
 *
 * Steps (each fails loudly with its own name):
 *   1. WHP is on.
 *   2. msb, pinned and checksum-verified.
 *   3. The pinned Codex on the agents volume.
 *   4a. A junction planted in a seat HOME is refused before anything runs, and
 *      the folder it points to is untouched.
 *   4. A Codex turn: the adapter boots the VM, Codex answers through the proxy,
 *      the stub's own request log (a host file) shows the host key arrived in
 *      the Authorization header of every request, and neither msb nor the
 *      guest's turn files carry the key.
 *   5. The same fence, probed from inside: the public internet and a
 *      loopback-only host service are unreachable, the fenced port is
 *      reachable, and the workspace and agents volume refuse writes. The host
 *      first reaches the same public URLs, or the step is inconclusive.
 *   6. A turn whose guest stalls is killed at a short timeout. While it runs,
 *      msb must list it under the seat's label, and must not list a control VM
 *      carrying another label there. The next turn of that seat still runs (its
 *      prepare stops any VM msb left), msb then lists no running VM with the
 *      seat's label, and the control VM is untouched.
 */
import { spawn } from 'child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  GUEST_CODEX, GUEST_CODEX_VERSION, GUEST_HOST, GUEST_IMAGE, GUEST_TURN_DIR, MICROVM_FLAG_ENV, ensureGuestCodex, ensureMsb,
  ensureNoSeatVm, microvmSeatLabel, msbHostEnv, prepareMicrovmHost, probeWhp, writeMicrovmTurn,
} from '../src/lib/sandbox/microsandbox.js';

const codex = (await import('../src/lib/adapters/codex.js')).default;

const FAKE_UPSTREAM_KEY = 'sk-test-fake-ci-upstream-key-0001';
const FAKE_SEAT_TOKEN = 'cm_agent_test_fake_ci_seat_token';

let currentStep = '';
const step = (text) => { currentStep = text; console.log(`\n== ${text}`); };
const failures = [];
const fail = (text) => { failures.push(`[${currentStep}] ${text}`); console.error(`FAIL [${currentStep}]: ${text}`); };

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const listenOn = (port, body) => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(body); });
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});

// The tool-call probe (step 4b). The command runs through Codex's own shell
// tool, so inside Codex's Linux sandbox (bwrap) in the guest. The workspace
// reads; a workspace write fails (read-only mount and profile); config.toml,
// which carries the bridge secret, is unreadable (bwrap binds only the
// profile's readable roots into an empty tmpfs); the network is unreachable
// (the VM's fence and the profile). A write to the Codex home "succeeds" into
// that private tmpfs; step 4b checks it never reaches the seat HOME.
const TOOL_PROBE_MARKER = 'RUN_TOOL_PROBE';
const TOOL_CALL_ID = 'call_ci_probe';
const TOOL_PROBE_INPUT = 'PROBE_INPUT_OK';
const TOOL_PROBE_SCRIPT = [
  'cat /workspace/probe-input.txt; echo',
  'if echo x > /workspace/tool-planted 2>/dev/null; then echo WS_WRITE=written; else echo WS_WRITE=refused; fi',
  'if echo x > /home/seat/codex-home/tool-planted 2>/dev/null; then echo HOME_WRITE=written; else echo HOME_WRITE=refused; fi',
  'echo HOME_FS=$(stat -f -c %T /home/seat/codex-home 2>/dev/null || echo unknown)',
  'if cat /home/seat/codex-home/config.toml >/dev/null 2>&1; then echo SECRET_READ=read; else echo SECRET_READ=refused; fi',
  "node -e \"const r=require('https').get('https://example.com/',{timeout:5000},()=>{console.log('NET=reached');process.exit(0)});"
    + "r.on('timeout',()=>{console.log('NET=blocked');process.exit(0)});r.on('error',()=>{console.log('NET=blocked');process.exit(0)})\"",
].join('\n');
const toolProbe = { offered: null, unusable: false, output: null };

// One shell call in the shape of the shell tool Codex offered, or null.
const toolCallItem = (tools = []) => {
  const names = new Set(tools.filter((tool) => tool?.type === 'function').map((tool) => tool.name));
  const call = (name, args) => ({
    type: 'function_call', id: 'fc_ci_probe', call_id: TOOL_CALL_ID, name, arguments: JSON.stringify(args), status: 'completed',
  });
  if (names.has('shell_command')) return call('shell_command', { command: TOOL_PROBE_SCRIPT, workdir: '/workspace' });
  if (names.has('shell')) return call('shell', { command: ['bash', '-lc', TOOL_PROBE_SCRIPT], workdir: '/workspace' });
  if (names.has('exec_command')) return call('exec_command', { cmd: TOOL_PROBE_SCRIPT, workdir: '/workspace' });
  if (tools.some((tool) => tool?.type === 'local_shell')) {
    return {
      type: 'local_shell_call', id: 'lsh_ci_probe', call_id: TOOL_CALL_ID, status: 'completed',
      action: { type: 'exec', command: ['bash', '-lc', TOOL_PROBE_SCRIPT], working_directory: '/workspace' },
    };
  }
  return null;
};

// The stub model: the Responses wire (from scripts/spikes/sandbox-front.mjs),
// echoing the bearer it was sent. The proxy redacts the key from every
// response body, so the echo proves nothing; what the stub received is
// written, one JSON line per request, to a host file the checks read back.
let requestLogPath = null;
const stubUpstream = (req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const path = req.url.split('?')[0];
    appendFileSync(requestLogPath, `${JSON.stringify({
      method: req.method, path, bearerIsKey: bearer === FAKE_UPSTREAM_KEY, bearerPresent: Boolean(bearer),
    })}\n`);
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'spike-model', object: 'model' }], models: [] }));
      return;
    }
    if (path.endsWith('/responses')) {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* not json */ }
      // Judged from this turn's user message on: a resumed thread carries the
      // earlier probe and its output in its history.
      const items = Array.isArray(body.input) ? body.input : [body.input];
      let from = items.length - 1;
      while (from > 0 && items[from]?.role !== 'user') from -= 1;
      const input = JSON.stringify(items[from] ?? '');
      const toolOutput = items.slice(from + 1)
        .find((entry) => entry?.call_id === TOOL_CALL_ID && String(entry?.type || '').endsWith('_output'));
      let item;
      if (input.includes(TOOL_PROBE_MARKER) && !toolOutput) {
        // The tool-call probe (step 4b): ask for one shell command, in the
        // shape of whichever shell tool this Codex offered.
        item = toolCallItem(body.tools);
        toolProbe.offered = (body.tools || []).map((tool) => (tool.type === 'function' ? tool.name : tool.type));
        if (!item) {
          toolProbe.unusable = true;
          item = {
            type: 'message', id: 'msg_ci', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'no shell tool offered', annotations: [] }],
          };
        }
      } else {
        if (toolOutput) toolProbe.output = typeof toolOutput.output === 'string' ? toolOutput.output : JSON.stringify(toolOutput.output);
        const text = toolOutput ? `TOOL_OUTPUT ${toolProbe.output}` : `OK from the stub model. key-echo=${bearer}`;
        item = {
          type: 'message', id: 'msg_ci', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }],
        };
      }
      const text = item.type === 'message' ? item.content[0].text : '';
      const usage = {
        input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 20,
      };
      const response = {
        id: 'resp_ci', object: 'response', model: body.model || 'spike-model', status: 'in_progress', output: [],
      };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const [event, data] of [
        ['response.created', { type: 'response.created', response }],
        ['response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: item.type === 'message' ? { ...item, status: 'in_progress', content: [] } : { ...item, status: 'in_progress' },
        }],
        ...(item.type === 'message' ? [['response.output_text.delta', {
          type: 'response.output_text.delta', item_id: 'msg_ci', output_index: 0, content_index: 0, delta: text,
        }]] : []),
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
        ['response.completed', { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage } }],
      ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'stub: no route' }));
  });
};

// Runs in the guest behind the codex turn's own fence. Reports outcomes only.
const GUEST_PROBE = `'use strict';
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const { writeFileSync } = require('fs');
const get = (mod, url) => new Promise((resolve) => {
  const req = mod.get(url, { timeout: 5000 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve('status ' + res.statusCode + ' ' + b.slice(0, 2000))); });
  req.on('timeout', () => { req.destroy(); resolve('blocked (timeout)'); });
  req.on('error', (e) => resolve('blocked (' + e.code + ')'));
});
const tryWrite = (path) => { try { writeFileSync(path, 'x'); return 'written'; } catch (e) { return 'refused (' + e.code + ')'; } };
(async () => {
  const report = {};
  report.fencedPort = await get(http, 'http://${GUEST_HOST}:' + process.argv[2] + '/');
  report.otherHostPort = await get(http, 'http://${GUEST_HOST}:' + process.argv[3] + '/');
  report.publicHttps = await get(https, 'https://example.com/');
  report.publicHttp = await get(http, 'http://example.com/');
  report.workspaceWrite = tryWrite('/workspace/should-not-exist');
  report.agentsVolumeWrite = tryWrite('/opt/agents/bin/planted');
  const codex = spawnSync('${GUEST_CODEX}', ['--version'], { encoding: 'utf8' });
  report.codex = String(codex.stdout || codex.error?.code || '').trim();
  console.log('PROBE ' + JSON.stringify(report));
})();
`;

// How a public request from the guest was blocked, or null if it was not.
// Exactly two answers count as blocked: no connection at all, or msb's own
// gateway accepting a plain-HTTP connection and answering 403 with a JSON body
// whose code is network_policy_denied (docs/plans/microsandbox-windows-spike.md,
// "Network fence"). Any other status or body is the site answering: reachable.
const publicBlockKind = (outcome) => {
  if (String(outcome).startsWith('blocked')) return `no connection (${outcome})`;
  const denied = /^status 403 (.*)$/s.exec(String(outcome));
  if (!denied) return null;
  try {
    return JSON.parse(denied[1])?.code === 'network_policy_denied' ? 'the msb gateway (403 network_policy_denied)' : null;
  } catch {
    return null;
  }
};

const runMsb = (msb, args) => new Promise((resolve, reject) => {
  const child = spawn(msb, args, { env: msbHostEnv(process.env), windowsHide: true });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => process.stderr.write(c));
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout }));
});

const main = async () => {
  if (process.env[MICROVM_FLAG_ENV] !== '1') throw new Error(`${MICROVM_FLAG_ENV}=1 must be set for this smoke`);

  step('1. WHP');
  const whp = probeWhp();
  console.log(JSON.stringify(whp));
  if (!whp.available) throw new Error(`this runner has no WHP: ${whp.error}`);

  step('2. msb, pinned and checksum-verified');
  const root = mkdtempSync(join(tmpdir(), 'commonly-msb-codex-'));
  const msb = await ensureMsb({ root });
  console.log(msb);

  step(`3. Codex ${GUEST_CODEX_VERSION} on the agents volume`);
  console.log(JSON.stringify(ensureGuestCodex({ msb, root, log: console.log })));

  const scratch = mkdtempSync(join(tmpdir(), 'commonly-cmv-smoke-'));
  requestLogPath = join(scratch, 'upstream-requests.jsonl');
  writeFileSync(requestLogPath, '');
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true });
  mkdirSync(home);
  const upstream = await listen(stubUpstream);
  const other = await listen((req, res) => { res.writeHead(200); res.end('loopback-only-service'); });
  let captured = null;
  try {
    step('4a. a junction planted in the seat home is refused, and its target untouched');
    {
      const plantedHome = join(scratch, 'planted-home');
      const target = join(scratch, 'junction-target');
      mkdirSync(plantedHome);
      mkdirSync(target);
      writeFileSync(join(target, 'AGENTS.override.md'), 'host file');
      symlinkSync(target, join(plantedHome, 'codex-home'), 'junction');
      const refused = await codex.spawn('hi', {
        agentName: 'ci-codex-junction',
        cwd: workspace,
        runtimeToken: FAKE_SEAT_TOKEN,
        env: { ...process.env, CODEX_API_KEY: FAKE_UPSTREAM_KEY },
        environment: { model: 'spike-model', sandbox: { trust: 'public' }, mcp: [] },
        _microvmHome: plantedHome,
        _prepareMicrovmHost: (options) => prepareMicrovmHost({ ...options, root }),
        _startProviderProxy: () => { throw new Error('a proxy started despite a planted junction'); },
      }).then(() => null, (error) => error);
      console.log(refused?.message);
      if (!refused || !/refusing to touch .* in the microVM seat home/.test(refused.message)) {
        fail(`a junction at codex-home was not refused: ${refused?.message || 'the turn ran'}`);
      }
      if (readdirSync(target).join(',') !== 'AGENTS.override.md'
        || readFileSync(join(target, 'AGENTS.override.md'), 'utf8') !== 'host file') {
        fail('the folder behind the junction was changed');
      }
    }

    step('4. a public Codex turn through the codex adapter, inside the microVM');
    const started = Date.now();
    // A failed turn is recorded, and the fence it was given is still probed.
    const result = await codex.spawn('Reply with OK.', {
      agentName: 'ci-codex-microvm',
      sessionId: null,
      cwd: workspace,
      runtimeToken: FAKE_SEAT_TOKEN,
      instanceUrl: 'http://127.0.0.1:9',
      timeoutMs: 5 * 60 * 1000,
      env: {
        ...process.env,
        CODEX_API_KEY: FAKE_UPSTREAM_KEY,
        OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
      },
      environment: { model: 'spike-model', sandbox: { trust: 'public' }, mcp: [] },
      _microvmHome: home,
      // The adapter's own preparation, on this smoke's msb folder.
      _prepareMicrovmHost: (options) => prepareMicrovmHost({ ...options, root }),
      // Records what the adapter handed msb, and the guest's turn files while
      // they exist, then runs it for real.
      _spawnImpl: (cmd, args, opts) => {
        const mount = args.find((a) => a.endsWith(`:${GUEST_TURN_DIR}:ro`));
        const turnDir = mount.slice(0, mount.length - `:${GUEST_TURN_DIR}:ro`.length);
        captured = {
          cmd,
          args: [...args],
          env: opts.env,
          turnFiles: readdirSync(turnDir).map((name) => readFileSync(join(turnDir, name), 'utf8')).join('\n'),
          mount,
        };
        console.log(`msb ${args.join(' ')}`);
        return spawn(cmd, args, opts);
      },
    }).catch((error) => {
      fail(`the turn failed: ${error?.message || error}`);
      return { text: '', newSessionId: null };
    });
    console.log(`turn finished after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log(JSON.stringify({ text: result.text, newSessionId: result.newSessionId }));
    const upstreamRequests = existsSync(requestLogPath)
      ? readFileSync(requestLogPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    console.log(`upstream request log: ${JSON.stringify(upstreamRequests)}`);

    if (!captured) fail('the adapter never spawned msb');
    else {
      if (captured.cmd !== msb) fail(`the adapter spawned ${captured.cmd}, not the pinned msb`);
      const ruleArg = captured.args[captured.args.indexOf('--net-rule') + 1] || '';
      if (captured.args[captured.args.indexOf('--net-rule') - 1] !== '--no-net') fail('--no-net does not precede the net rules');
      if (ruleArg.split(',').some((rule) => rule !== 'allow@dns' && !/^allow@host:tcp:\d+$/.test(rule))) fail(`a rule other than DNS or an exact host port: ${ruleArg}`);
      if (!captured.turnFiles.includes(GUEST_CODEX)) fail('the guest argv does not run the pinned Codex');
      const exposed = [captured.args.join(' '), JSON.stringify(captured.env), captured.turnFiles].join('\n');
      if (exposed.includes(FAKE_UPSTREAM_KEY)) fail('the provider key reached msb or the guest turn files');
      if (exposed.includes(FAKE_SEAT_TOKEN)) fail('the seat token reached msb or the guest turn files');
    }
    if (!String(result.text).includes('OK from the stub model')) fail(`Codex did not answer through the proxy: ${JSON.stringify(result.text)}`);
    if (!upstreamRequests.some((r) => r.method === 'POST' && r.path.endsWith('/responses') && r.bearerIsKey)) {
      fail('the stub logged no Responses call whose Authorization header carried the host key');
    }
    if (upstreamRequests.some((r) => !r.bearerIsKey)) {
      fail('the stub logged a request whose Authorization header was not the host key (the proxy did not put it there)');
    }
    if (!result.newSessionId) fail('the turn reported no thread id');

    step('4b. a Codex shell call inside the guest: what it reads, and that nothing it writes persists');
    {
      const toolHome = join(scratch, 'tool-home');
      const toolCodexHome = join(toolHome, 'codex-home');
      mkdirSync(toolHome);
      writeFileSync(join(workspace, 'probe-input.txt'), TOOL_PROBE_INPUT);
      let configAtSpawn = false;
      const toolTurn = (prompt, extra = {}) => codex.spawn(prompt, {
        agentName: 'ci-codex-tool',
        sessionId: null,
        cwd: workspace,
        runtimeToken: FAKE_SEAT_TOKEN,
        instanceUrl: 'http://127.0.0.1:9',
        timeoutMs: 5 * 60 * 1000,
        env: {
          ...process.env,
          CODEX_API_KEY: FAKE_UPSTREAM_KEY,
          OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
        },
        environment: { model: 'spike-model', sandbox: { trust: 'public' }, mcp: [] },
        _microvmHome: toolHome,
        _prepareMicrovmHost: (options) => prepareMicrovmHost({ ...options, root }),
        ...extra,
      });
      const probed = await toolTurn(`${TOOL_PROBE_MARKER}: run the probe.`, {
        _spawnImpl: (cmd, args, opts) => {
          configAtSpawn = existsSync(join(toolCodexHome, 'config.toml'));
          return spawn(cmd, args, opts);
        },
      }).catch((error) => { fail(`the tool-call turn failed: ${error?.message || error}`); return { text: '' }; });
      console.log(`tools offered: ${JSON.stringify(toolProbe.offered)}`);
      console.log(`tool output: ${JSON.stringify(toolProbe.output)}`);
      console.log(`reply: ${JSON.stringify(probed.text)}`);
      if (toolProbe.unusable) throw new Error(`inconclusive: Codex offered no shell tool this stub knows (${JSON.stringify(toolProbe.offered)})`);
      if (toolProbe.output === null) fail('Codex never returned the shell call\'s output to the model');
      const out = String(toolProbe.output || '');
      // Profile reads (bwrap binds only the readable roots into an empty tmpfs):
      if (!out.includes(TOOL_PROBE_INPUT)) fail('the shell could not read the workspace (the positive control)');
      if (!configAtSpawn) fail('no config.toml was in the Codex home when the turn started, so the read check proves nothing');
      if (!out.includes('SECRET_READ=refused')) fail('the shell read the config.toml that carries the bridge secret');
      // Mount and profile writes:
      if (!out.includes('WS_WRITE=refused')) fail('the shell wrote into the workspace');
      // VM network:
      if (!out.includes('NET=blocked')) fail('the shell reached the internet');
      // A write to the Codex home lands in bwrap's private tmpfs, which the
      // shell sees as "written"; it must never reach the seat HOME.
      const homeWrite = /HOME_WRITE=(\w+)/.exec(out)?.[1] || 'unknown';
      const homeFs = /HOME_FS=(\S+)/.exec(out)?.[1] || 'unknown';
      console.log(`the shell's write to the Codex home: ${homeWrite}, on ${homeFs} as the shell sees it`);
      if (existsSync(join(workspace, 'tool-planted'))) fail('a file the shell wrote is in the workspace');
      if (existsSync(join(toolCodexHome, 'tool-planted'))) fail('a file the shell wrote reached the seat HOME\'s Codex home');
      // Positive control: Codex itself (outside bwrap) does write its home, so
      // the host view above is the guest's real one.
      const rollouts = [];
      const walk = (dir, depth) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && depth < 3) walk(join(dir, entry.name), depth + 1);
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) rollouts.push(entry.name);
        }
      };
      if (existsSync(join(toolCodexHome, 'sessions'))) walk(join(toolCodexHome, 'sessions'), 0);
      console.log(`rollouts Codex wrote: ${JSON.stringify(rollouts)}`);
      if (!rollouts.length) fail('Codex left no rollout in its home, so the host view of that home proves nothing');
      rmSync(join(workspace, 'probe-input.txt'), { force: true });

      // The next turn of the seat: anything left in the Codex home outside
      // sessions/ and tmp/arg0-linux (what Codex, which runs outside bwrap,
      // could have written there) is gone by the time msb launches. A guest
      // shell check would prove nothing here (its view of the home is bwrap's
      // empty tmpfs), so the check reads the seat HOME at the launch itself.
      const planted = ['memories', 'log', 'history.jsonl', 'future-extension.toml', 'AGENTS.override.md'];
      for (const name of planted) {
        if (name.includes('.')) writeFileSync(join(toolCodexHome, name), 'planted');
        else {
          mkdirSync(join(toolCodexHome, name), { recursive: true });
          writeFileSync(join(toolCodexHome, name, 'planted.md'), 'planted');
        }
      }
      writeFileSync(join(toolCodexHome, 'tmp', 'planted.txt'), 'planted');
      let atLaunch = null;
      toolProbe.output = null;
      const next = await toolTurn('Reply with OK.', {
        sessionId: probed.newSessionId || null,
        _spawnImpl: (cmd, args, opts) => {
          atLaunch = {
            entries: readdirSync(toolCodexHome).sort(),
            tmp: readdirSync(join(toolCodexHome, 'tmp')).sort(),
            resumes: args.includes('resume'),
          };
          return spawn(cmd, args, opts);
        },
      }).catch((error) => { fail(`the turn after the planting failed: ${error?.message || error}`); return { text: '' }; });
      console.log(`the next turn's Codex home at launch: ${JSON.stringify(atLaunch)}`);
      if (!atLaunch) fail('the next turn never launched msb');
      else {
        const left = planted.filter((name) => atLaunch.entries.includes(name));
        if (left.length) fail(`left in the Codex home for the next turn: ${left.join(', ')}`);
        if (atLaunch.tmp.includes('planted.txt')) fail('a file planted in the Codex home\'s tmp/ reached the next turn');
        if (!atLaunch.entries.includes('sessions')) fail('the seat\'s sessions were cleared, so its thread cannot resume');
        if (probed.newSessionId && !atLaunch.resumes) fail('the next turn did not resume the seat\'s thread');
      }
      if (!String(next.text).includes('OK from the stub model')) fail(`the next turn did not answer: ${JSON.stringify(next.text)}`);
    }

    step('5. the same fence, probed from inside the guest');
    if (!captured) throw new Error('no fence to probe: step 4 never spawned msb');
    const rules = captured.args[captured.args.indexOf('--net-rule') + 1].split(',');
    const fencedPorts = rules.filter((rule) => rule.startsWith('allow@host:tcp:')).map((rule) => Number(rule.split(':').pop()));
    if (fencedPorts.length !== 1) fail(`a turn with no MCP server should open exactly one host port (the proxy), got ${fencedPorts.join(', ')}`);
    // Positive control for the internet: the host itself reaches the URLs the
    // guest must not, or a runner with no internet would pass vacuously.
    for (const url of ['https://example.com/', 'http://example.com/']) {
      // eslint-disable-next-line no-await-in-loop
      const reached = await fetch(url, { signal: AbortSignal.timeout(10000) })
        .then((res) => `status ${res.status}`, (error) => `failed (${error?.cause?.code || error?.message})`);
      console.log(`host -> ${url}: ${reached}`);
      if (!reached.startsWith('status')) {
        throw new Error(`inconclusive: this runner's host cannot reach ${url} (${reached}), so the guest's refusal proves nothing`);
      }
    }
    // The proxy closed with the turn; a stand-in takes its port as the positive control.
    const standIn = await listenOn(fencedPorts[0], 'fenced-port-ok');
    const probeDir = mkdtempSync(join(tmpdir(), 'commonly-cmv-probe-'));
    try {
      await writeMicrovmTurn(probeDir, {
        argv: ['node', `${GUEST_TURN_DIR}/probe.js`, String(fencedPorts[0]), String(other.address().port)],
        env: { HOME: '/home/seat', PATH: '/opt/agents/bin:/usr/local/bin:/usr/bin:/bin' },
      });
      writeFileSync(join(probeDir, 'probe.js'), GUEST_PROBE);
      const args = captured.args.map((arg) => (arg === captured.mount ? `${probeDir}:${GUEST_TURN_DIR}:ro` : arg));
      const out = await runMsb(msb, args);
      console.log(`probe exit ${out.code}`);
      const line = out.stdout.split(/\r?\n/).find((l) => l.startsWith('PROBE '));
      if (!line) throw new Error(`no probe report:\n${out.stdout}`);
      const report = JSON.parse(line.slice('PROBE '.length));
      console.log(JSON.stringify(report, null, 2));
      if (!report.fencedPort.startsWith('status 200 fenced-port-ok')) fail(`the fenced port was not reachable: ${report.fencedPort}`);
      if (!report.otherHostPort.startsWith('blocked')) fail(`a non-allowed host port was reachable: ${report.otherHostPort}`);
      for (const [name, outcome] of [['https', report.publicHttps], ['http', report.publicHttp]]) {
        const kind = publicBlockKind(outcome);
        console.log(`public ${name}: ${kind ? `blocked by ${kind}` : 'REACHABLE'}`);
        if (!kind) fail(`the public internet (${name}) was reachable: ${outcome}`);
      }
      if (!report.workspaceWrite.startsWith('refused')) fail(`the read-only workspace took a write: ${report.workspaceWrite}`);
      if (!report.agentsVolumeWrite.startsWith('refused')) fail(`a turn could write the agents volume: ${report.agentsVolumeWrite}`);
      if (!report.codex.includes(GUEST_CODEX_VERSION)) fail(`Codex ${GUEST_CODEX_VERSION} is not on the volume: ${report.codex}`);
    } finally {
      standIn.close();
      rmSync(probeDir, { recursive: true, force: true });
    }

    step('6. a turn killed at its timeout leaves no VM of its seat behind the next turn');
    {
      const stallHome = join(scratch, 'stall-home');
      mkdirSync(stallHome);
      const label = microvmSeatLabel(stallHome);
      const vmsLabelled = async (selector, { raw = false } = {}) => {
        const out = await runMsb(msb, ['list', '--label', selector, '--format', 'json']);
        if (raw) console.log(`raw: msb list --label ${selector} --format json (exit ${out.code}):\n${out.stdout}`);
        if (out.code !== 0) throw new Error(`msb list exited ${out.code}`);
        return JSON.parse(out.stdout.trim() || '[]').filter((vm) => !['Stopped', 'Crashed'].includes(vm.status));
      };
      const seatVms = () => vmsLabelled(label);
      // A control VM under another seat's label: the selector must not match it,
      // and its own label must, or the listing proves nothing either way.
      const controlLabel = 'commonly-seat=smoke-control-public';
      const control = await runMsb(msb, ['run', '--detach', '--no-net', '--label', controlLabel, GUEST_IMAGE, '--', 'sleep', '600']);
      const controlName = control.stdout.trim().split(/\r?\n/).pop();
      console.log(`control VM: ${controlName} (exit ${control.code})`);
      if (control.code !== 0 || !controlName) throw new Error('inconclusive: the control VM under another label did not start');
      // Positive control, taken while the stalled guest runs (after it marks
      // the HOME, before the kill): msb must list it under the seat's label.
      let duringStall = null;
      const watchStall = async () => {
        const marker = join(stallHome, 'stall-started');
        for (let i = 0; i < 50 && !existsSync(marker); i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => { setTimeout(resolve, 1000); });
        }
        if (!existsSync(marker)) return;
        duringStall = {
          seat: await vmsLabelled(label, { raw: true }),
          control: await vmsLabelled(controlLabel, { raw: true }),
        };
      };
      let watching = null;
      const turnCtx = (extra) => ({
        agentName: 'ci-codex-stall',
        sessionId: null,
        cwd: workspace,
        runtimeToken: FAKE_SEAT_TOKEN,
        instanceUrl: 'http://127.0.0.1:9',
        env: {
          ...process.env,
          CODEX_API_KEY: FAKE_UPSTREAM_KEY,
          OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
        },
        environment: { model: 'spike-model', sandbox: { trust: 'public' }, mcp: [] },
        _microvmHome: stallHome,
        _prepareMicrovmHost: (options) => prepareMicrovmHost({ ...options, root }),
        ...extra,
      });
      // The guest stalls: its turn file is swapped for one that marks the HOME
      // and then idles, so the adapter's timeout kills msb.exe mid-turn.
      const killedTurn = await codex.spawn('stall', turnCtx({
        timeoutMs: 60 * 1000,
        _spawnImpl: (cmd, args, opts) => {
          const mount = args.find((a) => a.endsWith(`:${GUEST_TURN_DIR}:ro`));
          const turnDir = mount.slice(0, mount.length - `:${GUEST_TURN_DIR}:ro`.length);
          const turn = JSON.parse(readFileSync(join(turnDir, 'turn.json'), 'utf8'));
          turn.argv = ['node', '-e', "require('fs').writeFileSync('/home/seat/stall-started', '1'); setInterval(() => {}, 1000);"];
          writeFileSync(join(turnDir, 'turn.json'), JSON.stringify(turn));
          watching = watchStall();
          return spawn(cmd, args, opts);
        },
      })).then(() => null, (error) => error);
      await watching;
      console.log(`killed turn: ${killedTurn?.message}`);
      console.log(`while the stalled guest ran: ${JSON.stringify(duringStall)}`);
      if (!duringStall) {
        fail('no listing was taken while the stalled guest ran');
      } else {
        if (!duringStall.seat.length) fail('msb listed no VM under the seat label while its guest ran: the label or the selector does not work, so step 6 would pass vacuously');
        if (duringStall.seat.some((vm) => vm.name === controlName)) fail('the seat label selector matched the control VM of another label');
        if (!duringStall.control.some((vm) => vm.name === controlName)) fail('the control VM was not listed under its own label');
      }
      if (!killedTurn || !/timed out/.test(killedTurn.message)) fail(`the stalled turn was not killed at its timeout: ${killedTurn?.message || 'it finished'}`);
      if (!existsSync(join(stallHome, 'stall-started'))) {
        throw new Error('inconclusive: the stalled guest never started before the kill; the timeout is too short for this runner');
      }
      // Informational: whether this msb leaves the VM running after its own
      // process is killed. The adapter must cope either way.
      console.log(`VMs of the seat right after the kill: ${JSON.stringify(await seatVms())}`);

      const next = await codex.spawn('Reply with OK.', turnCtx({ timeoutMs: 5 * 60 * 1000 }))
        .catch((error) => { fail(`the next turn of the seat did not run: ${error?.message || error}`); return null; });
      if (next && !String(next.text).includes('OK from the stub model')) fail(`the next turn did not answer: ${JSON.stringify(next.text)}`);
      const left = await seatVms();
      console.log(`VMs of the seat after the next turn: ${JSON.stringify(left)}`);
      if (left.length) fail(`a VM of the seat is still running: ${JSON.stringify(left)}`);
      // The next turn's check must have left the other label's VM alone.
      if (!(await vmsLabelled(controlLabel)).some((vm) => vm.name === controlName)) {
        fail('the control VM of another label was stopped by this seat\'s turn');
      }
      await runMsb(msb, ['stop', '--force', '--quiet', '--', controlName]);
      await runMsb(msb, ['rm', '--', controlName]);
    }

    step('7. an orphaned msb.exe of a seat is killed before the next turn touches its HOME');
    {
      const orphanHome = join(scratch, 'orphan-home');
      mkdirSync(orphanHome);
      // A stand-in orphan: a process named msb.exe (a copy of node) whose
      // command line carries the seat's label and HOME, as a real `msb run`'s does.
      const fakeDir = join(scratch, 'fake-msb');
      mkdirSync(fakeDir);
      const fakeMsb = join(fakeDir, 'msb.exe');
      copyFileSync(process.execPath, fakeMsb);
      const orphan = spawn(fakeMsb, [
        '-e', 'setInterval(() => {}, 1000)', 'run', '--label', microvmSeatLabel(orphanHome), '--mount-dir', `${orphanHome}:/home/seat`,
      ], { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      if (!alive(orphan.pid)) throw new Error('inconclusive: the stand-in orphan msb.exe did not start');
      let atCheck = null;
      const turnResult = await codex.spawn('Reply with OK.', {
        agentName: 'ci-codex-orphan',
        sessionId: null,
        cwd: workspace,
        runtimeToken: FAKE_SEAT_TOKEN,
        instanceUrl: 'http://127.0.0.1:9',
        timeoutMs: 5 * 60 * 1000,
        env: {
          ...process.env,
          CODEX_API_KEY: FAKE_UPSTREAM_KEY,
          OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
        },
        environment: { model: 'spike-model', sandbox: { trust: 'public' }, mcp: [] },
        _microvmHome: orphanHome,
        _prepareMicrovmHost: (options) => prepareMicrovmHost({ ...options, root }),
        // The first VM check runs after the orphan sweep and before any HOME step.
        _ensureNoSeatVm: (options) => {
          if (!atCheck) atCheck = { orphanAlive: alive(orphan.pid), homeTouched: existsSync(join(orphanHome, 'codex-home')) };
          return ensureNoSeatVm(options);
        },
      }).catch((error) => { fail(`the turn after the orphan did not run: ${error?.message || error}`); return { text: '' }; });
      console.log(`at the first VM check: ${JSON.stringify(atCheck)}`);
      if (!atCheck) fail('the turn never reached its VM check');
      else {
        if (atCheck.orphanAlive) fail('the orphaned msb.exe of the seat was still running at the VM check');
        if (atCheck.homeTouched) fail('the HOME was touched before the orphan sweep and the VM check');
      }
      if (alive(orphan.pid)) {
        fail('the orphaned msb.exe of the seat is still running');
        try { process.kill(orphan.pid); } catch { /* gone */ }
      }
      if (!String(turnResult.text).includes('OK from the stub model')) fail(`the turn did not answer: ${JSON.stringify(turnResult.text)}`);
    }
  } finally {
    upstream.close();
    other.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('\nOK: a public Codex turn ran inside the microVM, and the fence held');
  }
};

main().catch((error) => { console.error(`FAIL [${currentStep}]:`, error); process.exit(1); });
