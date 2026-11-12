#!/usr/bin/env node
/**
 * F470: does a public Codex seat whose Codex home is under /tmp still run a
 * sandboxed turn? Codex 0.164 failed every such turn (it would not create its
 * arg0 helper under the temp folder, so bwrap could not exec it), and the CLI
 * refuses that home since F186. Codex 0.167 logs the same refusal as a warning
 * and carries on, so this measures whether a turn now completes. The answer
 * decides whether the public refusal should depend on the Codex version.
 * (A private seat is refused whatever Codex does, because its profile denies
 * the temp roots whole and so hides the helper.)
 *
 * It runs two turns through the adapter on real Codex and a stub model on
 * loopback, with no secrets and no network. Each turn asks for one shell
 * command, and the turn counts only if the command's computed output comes back:
 *   control: XDG_STATE_HOME outside the temp folder
 *   temp:    XDG_STATE_HOME under /tmp
 * PROBE_ADAPTER points at a published CLI's codex.js. Use one from before F186
 * (0.1.357 or older) so the temp case reaches Codex. Linux, with bwrap able to
 * make a user namespace (a GitHub ubuntu-22.04 runner, not Docker).
 * byo-linux.yml runs it as walk=public-codex-temp-home.
 */
import { spawnSync } from 'child_process';
import { appendFileSync, existsSync, readdirSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import http from 'http';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = process.env.PROBE_ADAPTER || join(HERE, '..', 'src', 'lib', 'adapters', 'codex.js');
const MARK = 'f470-sandboxed-';
// Planted in the seat's ~/.commonly, which the public profile denies: a turn
// whose shell can print it ran outside the sandbox and answers nothing.
const LEAK = 'f470-unsandboxed-read';
const log = (line) => console.log(line);

const message = (text) => ({ type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text }] });

// A Responses-API stub: the first request gets one exec_command call, every
// later one a plain reply. Any CONNECT (a host other than loopback) is refused.
const startModel = async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || !/\/responses$/.test(req.url)) { res.writeHead(404); res.end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const items = requests.length === 1
        ? [{
          type: 'function_call',
          name: 'exec_command',
          call_id: 'probe',
          // The shell computes the number, so the marker proves the command ran; the
          // read of the denied ~/.commonly must fail, which proves it ran sandboxed.
          arguments: JSON.stringify({
            cmd: `echo ${MARK}$((6*7)); cat "$HOME/.commonly/probe.txt" 2>&1 | head -c 200`,
            yield_time_ms: 10000,
          }),
        }]
        : [message('done')];
      const id = `r${requests.length}`;
      const events = [
        { type: 'response.created', response: { id } },
        ...items.map((item) => ({ type: 'response.output_item.done', item })),
        { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  server.on('connect', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { requests, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
};

const outputOf = (body) => JSON.stringify((body?.input || []).find((i) => i.call_id === 'probe' && /output/.test(i.type))?.output ?? null);

// The adapter from F186 on refuses a home under /tmp itself, so a run on it
// would answer for the CLI, not for Codex.
const refusedByCli = (outcome) => /code=codex_home_under_temp/.test(outcome);

const walk = (dir, depth = 0) => (existsSync(dir) && depth < 6
  ? readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => [join(dir, e.name), ...(e.isDirectory() ? walk(join(dir, e.name), depth + 1) : [])])
  : []);

const adapterVersion = async () => {
  const pkg = join(dirname(ADAPTER_PATH), '..', '..', '..', 'package.json');
  try { return JSON.parse(await readFile(pkg, 'utf8')).version; } catch { return '?'; }
};

const turn = async (codex, label, stateHome) => {
  const base = process.env.RUNNER_TEMP || join(homedir(), '.cache');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'f470-probe-'));
  await Promise.all(['workspace', 'home/.commonly', 'operator'].map((d) => mkdir(join(root, d), { recursive: true })));
  await writeFile(join(root, 'home', '.commonly', 'probe.txt'), LEAK);
  await writeFile(join(root, 'operator', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'stub-key' }));
  const model = await startModel();
  const proxy = `http://127.0.0.1:${model.port}`;
  log(`\n== ${label}: XDG_STATE_HOME=${stateHome}`);
  let outcome;
  try {
    try {
    const result = await codex.spawn('run the probe', {
      sessionId: null,
      cwd: join(root, 'workspace'),
      agentName: 'f470-probe',
      timeoutMs: 90000,
      environment: { model: 'gpt-5.5', sandbox: { trust: 'public', mode: 'workspace' } },
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        XDG_STATE_HOME: stateHome,
        CODEX_HOME: join(root, 'operator'),
        OPENAI_BASE_URL: `${proxy}/v1`,
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        ALL_PROXY: proxy,
        NO_PROXY: '127.0.0.1,localhost',
      },
      _homeDir: join(root, 'home'),
      _workspaceGitServer: () => null,
    });
      outcome = `spawn resolved, reply ${JSON.stringify(String(result?.text ?? '')).slice(0, 120)}`;
    } catch (error) {
      outcome = `spawn rejected code=${error?.code ?? '-'}: ${String(error?.message).slice(0, 900)}`;
    }
    const output = outputOf(model.requests.at(-1));
    const ran = output.includes(`${MARK}42`);
    const leaked = output.includes(LEAK);
    log(outcome);
    log(`model requests: ${model.requests.length} | shell output: ${output.slice(0, 400)}`);
    // What the arg0-linux folder holds (Codex's helper aliases), not the folder itself.
    const helper = walk(join(stateHome, 'commonly', 'codex-homes'))
      .filter((p) => /\/arg0-linux\/./.test(p)).map((p) => p.split('/').pop());
    log(`inside arg0-linux: ${helper.length}${helper.length ? ` (${helper.slice(0, 4).join(', ')})` : ''}`);
    const verdict = refusedByCli(outcome) ? 'CLI REFUSED (an adapter from F186 on; use a cli_version of 0.1.357 or older)'
      : leaked ? 'UNSANDBOXED (the shell read the denied ~/.commonly; this run answers nothing)'
        : ran ? 'TURN RAN (sandboxed: command output returned, denied read failed)'
          : 'NO TURN (command output missing)';
    log(`RESULT ${label}: ${verdict}`);
    return { ran: ran && !leaked, verdict, cliRefused: refusedByCli(outcome) };
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
};

const codexVersion = spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim() || 'codex not found';
log(`platform ${process.platform} | ${codexVersion} | adapter ${process.env.PROBE_ADAPTER ? 'published' : 'this checkout'} @commonlyai/cli ${await adapterVersion()}`);
log(`bwrap: ${spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).stdout?.trim() || 'not found'}`);
const { default: codex } = await import(pathToFileURL(ADAPTER_PATH).href);

const outside = await mkdtemp(join(process.env.RUNNER_TEMP || join(homedir(), '.cache'), 'f470-state-'));
const underTmp = await mkdtemp('/tmp/f470-state-');
let control;
let temp;
try {
  control = await turn(codex, 'control', join(outside, 'state'));
  temp = await turn(codex, 'temp', join(underTmp, 'state'));
} finally {
  await rm(outside, { recursive: true, force: true });
  await rm(underTmp, { recursive: true, force: true });
}
const summary = `SUMMARY ${codexVersion}: control ${control.verdict} | home under /tmp ${temp.verdict}`;
log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
// The control must run sandboxed, and the temp case must reach Codex, or the
// run can't answer the question.
process.exit(control.ran && !temp.cliRefused ? 0 : 1);
