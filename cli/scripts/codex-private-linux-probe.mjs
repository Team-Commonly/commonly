#!/usr/bin/env node
/**
 * F444: what Codex's Linux sandbox does with a private seat's permission keys,
 * measured on a real Linux host with bubblewrap and the real Codex binary.
 * No model, no Commonly server, no secrets. Run by byo-linux.yml when it is
 * dispatched with walk=private-codex.
 *
 * A fake home holds a marker in every place a private seat must not reach:
 * another seat's token and workspace, Commonly state, the Codex login and its
 * sessions, ~/.ssh, and another turn's per-turn folder in the temp root.
 *
 *   rules   `codex sandbox` with small hand-made profiles, to learn how Codex
 *           builds bwrap from a key: a denied ancestor, a file deny, a write
 *           inside a deny, a path that doesn't exist. Reported, never failed.
 *   keys    the adapter's own private profile, captured from its argv, run
 *           through `codex sandbox` with the checks below.
 *   turn    one real turn through the adapter with a stub model that runs
 *           the same checks through Codex's shell tool.
 *
 * A check passes when what the seat must reach works and no marker comes back.
 * Usage: node cli/scripts/codex-private-linux-probe.mjs [rules|keys|turn ...]
 */
import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import http from 'http';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX = process.env.CODEX_BIN || 'codex';
const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['rules', 'keys', 'turn'];
const MARK = (name) => `PROBE-MARKER-${name}-7c1e`;
let failures = 0;

const log = (line) => console.log(line);
const clip = (text, n = 200) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// The layout a private seat finds on a person's machine.
const makeHome = async () => {
  // Outside every temp root: the profile denies those whole, which would hide
  // what the keys do to a home and a workspace.
  const base = process.env.PROBE_ROOT || process.env.RUNNER_TEMP || join(homedir(), '.cache');
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(join(base, 'f444-probe-')));
  const home = join(root, 'home');
  const files = {
    '.commonly/tokens/other-seat.json': `{"runtimeToken":"${MARK('TOKEN')}"}`,
    '.commonly/state/notes.md': MARK('STATE'),
    '.commonly/workspaces/other/secret.txt': MARK('OTHERWS'),
    '.codex/auth.json': JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: MARK('AUTH') }),
    '.codex/sessions/old.jsonl': MARK('SESSIONS'),
    '.codex/config.toml': '',
    // Databases Codex keeps in its home: one it is known to keep, and one
    // under a name the adapter doesn't know. Their -wal appears during the turn.
    '.codex/logs_2.sqlite': MARK('DB'),
    '.codex/other_7.sqlite': MARK('DB'),
    // A public seat's Codex home, where the adapter keeps them on Linux.
    '.local/state/commonly/codex-homes/probe-public/sessions/s.jsonl': MARK('PUBHOME'),
    '.ssh/id_probe': MARK('SSH'),
    '.config/gh/hosts.yml': 'github.com:\n  user: probe\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(home, rel)), { recursive: true });
    await writeFile(join(home, rel), body);
  }
  const workspace = join(home, '.commonly', 'workspaces', 'self');
  await mkdir(workspace, { recursive: true });
  git(workspace, 'init', '-q');
  await writeFile(join(workspace, 'a.txt'), 'one\n');
  git(workspace, 'add', 'a.txt');
  git(workspace, '-c', 'user.name=P', '-c', 'user.email=p@example.com', 'commit', '-q', '-m', 'base');
  // Another seat's turn, as the adapter leaves it in the temp root.
  const otherTurn = await realpath(await mkdtemp(join(tmpdir(), 'commonly-codex-')));
  await writeFile(join(otherTurn, 'token'), MARK('TURN'));
  await writeFile(join(otherTurn, 'last-message.txt'), 'other turn reply');
  return { root, home, workspace, otherTurn };
};

// What Codex writes into its home after the turn's keys were built: the -wal
// of a known database, of one under an unknown name that was there at start,
// and of a known one that wasn't there at all.
const writeLateFiles = ({ home }) => {
  writeFileSync(join(home, '.codex', 'logs_2.sqlite-wal'), MARK('WAL'));
  writeFileSync(join(home, '.codex', 'other_7.sqlite-wal'), MARK('LATEWAL'));
  writeFileSync(join(home, '.codex', 'state_5.sqlite-wal'), MARK('KNOWNWAL'));
};

// Each line: R <name> <exit> <output>. Reads are judged on the marker, writes
// again from the host afterwards.
const checkScript = ({ home, otherTurn }) => [
  'r(){ n=$1; shift; o=$("$@" 2>&1); s=$?; printf "R %s %s %s\\n" "$n" "$s" "$(printf %s "$o" | tr "\\n" " " | cut -c1-160)"; }',
  "r ws_write sh -c 'echo hi > probe-write.txt'",
  "r heredoc sh -c 'cat > probe-heredoc.txt <<EOF\nheredoc-ok\nEOF'",
  'r tmpdir_write sh -c \'echo t > "$TMPDIR/probe" && cat "$TMPDIR/probe"\'',
  "r commit sh -c 'git add probe-write.txt && git -c user.name=P -c user.email=p@example.com commit -q -m probe && git log -1 --format=%s'",
  `r read_token cat ${home}/.commonly/tokens/other-seat.json`,
  `r read_state cat ${home}/.commonly/state/notes.md`,
  `r read_other_ws cat ${home}/.commonly/workspaces/other/secret.txt`,
  `r list_workspaces ls ${home}/.commonly/workspaces`,
  `r read_codex_auth cat ${home}/.codex/auth.json`,
  `r read_codex_sessions cat ${home}/.codex/sessions/old.jsonl`,
  `r read_ssh cat ${home}/.ssh/id_probe`,
  `r read_codex_db cat ${home}/.codex/logs_2.sqlite`,
  `r read_codex_wal cat ${home}/.codex/logs_2.sqlite-wal`,
  `r read_codex_late_wal cat ${home}/.codex/other_7.sqlite-wal`,
  `r read_codex_known_wal cat ${home}/.codex/state_5.sqlite-wal`,
  `r read_public_home cat ${home}/.local/state/commonly/codex-homes/probe-public/sessions/s.jsonl`,
  `r read_other_turn cat ${otherTurn}/token`,
  `r write_other_turn sh -c 'echo pwned > ${otherTurn}/last-message.txt'`,
  "r write_hook sh -c 'echo x > .git/hooks/pre-commit'",
  'r git_config git config core.probe 1',
  `r read_gh_hosts cat ${home}/.config/gh/hosts.yml`,
  'r tmp_env sh -c \'echo "TMPDIR=$TMPDIR"\'',
  'echo R done 0 end',
].join('\n');

const parse = (out) => Object.fromEntries(String(out).split('\n')
  .map((line) => /^R (\S+) (\d+) ?(.*)$/.exec(line))
  .filter(Boolean)
  .map(([, name, code, text]) => [name, { code: Number(code), text }]));

const judge = (label, results, ctx) => {
  const { workspace, otherTurn } = ctx;
  const expectOk = ['ws_write', 'heredoc', 'tmpdir_write', 'commit', 'read_gh_hosts'];
  const markers = {
    read_token: 'TOKEN', read_state: 'STATE', read_other_ws: 'OTHERWS', read_codex_auth: 'AUTH',
    read_codex_sessions: 'SESSIONS', read_ssh: 'SSH', read_other_turn: 'TURN',
    read_codex_db: 'DB', read_codex_wal: 'WAL', read_codex_late_wal: 'LATEWAL', read_codex_known_wal: 'KNOWNWAL',
    // macOS keeps public homes under ~/.commonly; this path is Linux's.
    ...(process.platform === 'linux' ? { read_public_home: 'PUBHOME' } : {}),
  };
  const rows = [];
  if (!results.done) rows.push(['ran', false, 'the check script never finished: the sandbox did not start']);
  for (const name of expectOk) {
    const r = results[name];
    rows.push([name, r?.code === 0, r ? `exit ${r.code}: ${clip(r.text, 120)}` : 'not run']);
  }
  rows.push(['heredoc_content', existsSync(join(workspace, 'probe-heredoc.txt'))
    && readFileSync(join(workspace, 'probe-heredoc.txt'), 'utf8').includes('heredoc-ok'), 'host read of probe-heredoc.txt']);
  for (const [name, mark] of Object.entries(markers)) {
    const r = results[name];
    rows.push([name, !!r && r.code !== 0 && !r.text.includes(MARK(mark)), r ? `exit ${r.code}: ${clip(r.text, 120)}` : 'not run']);
  }
  rows.push(['list_workspaces', !!results.list_workspaces && !/\bother\b/.test(results.list_workspaces.text),
    clip(results.list_workspaces?.text, 120)]);
  rows.push(['write_other_turn', readFileSync(join(otherTurn, 'last-message.txt'), 'utf8') === 'other turn reply',
    `exit ${results.write_other_turn?.code}`]);
  rows.push(['write_hook', !existsSync(join(workspace, '.git', 'hooks', 'pre-commit')), `exit ${results.write_hook?.code}`]);
  rows.push(['git_config', !readFileSync(join(workspace, '.git', 'config'), 'utf8').includes('probe'),
    `exit ${results.git_config?.code}`]);
  log(`\n== ${label} ==`);
  for (const [name, ok, detail] of rows) {
    log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(20)} ${detail}`);
    if (!ok) failures += 1;
  }
  log(`   (TMPDIR in the shell: ${clip(results.tmp_env?.text, 160)})`);
};

const sandbox = (flags, script, { cwd, env }) => spawnSync(CODEX, ['sandbox', ...flags, '--', 'bash', '-c', script], {
  cwd, env, encoding: 'utf8', timeout: 60_000,
});

const baseEnv = (home) => ({
  PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), LANG: 'C.UTF-8',
});

// --- rules -----------------------------------------------------------------
const rules = async () => {
  const ctx = await makeHome();
  const { home, workspace } = ctx;
  const profile = (entries) => [
    '-c', 'default_permissions="probe"',
    '-c', `permissions.probe.filesystem={${entries.join(',')}}`,
    '-c', 'permissions.probe.network.enabled=true',
  ];
  const q = (p) => JSON.stringify(p);
  const writable = join(home, '.local', 'state', 'probe-w');
  await mkdir(writable, { recursive: true });
  const tmpWrite = await mkdtemp(join(tmpdir(), 'f444-tmpw-'));
  const cases = [
    ['baseline: / read', ['"/"="read"'], 'echo started'],
    ['CODEX_HOME denied whole', ['"/"="read"', `${q(join(home, '.codex'))}="deny"`], 'echo started'],
    ['file deny inside a readable folder', ['"/"="read"', `${q(join(home, '.codex', 'auth.json'))}="deny"`],
      `echo started; cat ${home}/.codex/auth.json; echo; cat ${home}/.codex/sessions/old.jsonl`],
    ['folder deny, sibling folder readable', ['"/"="read"', `${q(join(home, '.commonly', 'tokens'))}="deny"`],
      `echo started; cat ${home}/.commonly/tokens/other-seat.json; echo; cat ${home}/.commonly/state/notes.md`],
    ['write inside a denied ancestor', ['"/"="read"', `${q(join(home, '.commonly'))}="deny"`, `${q(workspace)}="write"`],
      `echo started; echo w > ${workspace}/w.txt && echo wrote; ls ${home}/.commonly`],
    ['write outside every deny', ['"/"="read"', `${q(writable)}="write"`], `echo started; echo w > ${writable}/w && echo wrote`],
    ['temp root denied, write inside it', ['"/"="read"', '"/tmp"="deny"', `${q(tmpWrite)}="write"`],
      `echo started; echo w > ${tmpWrite}/w && echo wrote`],
    ['deny a path that does not exist', ['"/"="read"', `${q(join(home, 'not-there', 'x'))}="deny"`], 'echo started'],
    ['deny a glob of files', ['"/"="read"', `${q(join(home, '.commonly', 'tokens', '*.json'))}="deny"`],
      `echo started; cat ${home}/.commonly/tokens/other-seat.json`],
    ['read under a denied folder, re-granted', ['"/"="read"', `${q(join(home, '.codex'))}="deny"`, `${q(join(home, '.codex', 'tmp'))}="read"`],
      'echo started'],
  ];
  log('\n== rules: how codex sandbox builds bwrap from a key (reported, never failed) ==');
  for (const [name, entries, script] of cases) {
    const r = sandbox(profile(entries), script, { cwd: workspace, env: baseEnv(home) });
    log(`-- ${name}\n   exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\n   out: ${clip(r.stdout, 400)}\n   err: ${clip(r.stderr, 400)}`);
  }
  await rm(ctx.root, { recursive: true, force: true });
  await rm(ctx.otherTurn, { recursive: true, force: true });
  await rm(tmpWrite, { recursive: true, force: true });
};

// --- keys ------------------------------------------------------------------
// PROBE_ADAPTER: a published CLI's adapter (byo-linux.yml cli_version), for a
// live proof of what people install; otherwise this checkout's.
const ADAPTER_PATH = process.env.PROBE_ADAPTER || join(HERE, '..', 'src', 'lib', 'adapters', 'codex.js');
const adapterModule = async () => (await import(ADAPTER_PATH)).default;

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.pid = 0;
  setImmediate(() => child.emit('close', 0));
  return child;
};

const seatCtx = (ctx, extra = {}) => ({
  cwd: ctx.workspace,
  agentName: 'probe-self',
  environment: { model: 'gpt-5.5' },
  env: { ...baseEnv(ctx.home), ...extra.env },
  timeoutMs: 120_000,
  // Where the adapter looks for public seats' Codex homes.
  _homeDir: ctx.home,
  ...extra.ctx,
});

const keys = async () => {
  const ctx = await makeHome();
  const adapter = await adapterModule();
  let argv = null;
  let spawnEnv = null;
  await adapter.spawn('probe', seatCtx(ctx, {
    ctx: {
      _spawnImpl: (_cmd, args, options) => { argv = args; spawnEnv = options.env; return fakeChild(); },
    },
  })).catch((err) => log(`(captured spawn ended: ${clip(err.message, 160)})`));
  if (!argv) throw new Error('the adapter never spawned codex');
  const flags = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '-c') flags.push('-c', argv[i + 1]);
  log('\n== keys: the adapter\'s private profile ==');
  for (let i = 1; i < flags.length; i += 2) log(`   -c ${flags[i]}`);
  // The adapter removes its turn folder when the turn ends; the shell's temp
  // folder inside it is put back so the profile's write key has a target.
  const shellTemp = /"TMPDIR"="([^"]+)"/.exec(flags.join(' '))?.[1];
  if (shellTemp) await mkdir(shellTemp, { recursive: true, mode: 0o700 });
  writeLateFiles(ctx);
  const r = sandbox(flags, checkScript(ctx), { cwd: ctx.workspace, env: { ...baseEnv(ctx.home), CODEX_HOME: spawnEnv?.CODEX_HOME || join(ctx.home, '.codex') } });
  log(`   exit ${r.status}; stderr: ${clip(r.stderr, 600)}`);
  judge('keys: the adapter\'s profile through codex sandbox', parse(r.stdout), ctx);
  if (shellTemp) await rm(dirname(shellTemp), { recursive: true, force: true });
  await rm(ctx.root, { recursive: true, force: true });
  await rm(ctx.otherTurn, { recursive: true, force: true });
};

// --- turn ------------------------------------------------------------------
const startModel = async (reply) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      if (req.method !== 'POST' || !/\/responses$/.test(req.url)) { res.writeHead(404); res.end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const items = (await reply(requests.length - 1, body)) || [{
        type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'done' }],
      }];
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
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    requests,
    port: server.address().port,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
};

const turn = async () => {
  const ctx = await makeHome();
  const adapter = await adapterModule();
  const script = checkScript(ctx);
  let toolNames = [];
  const model = await startModel((index, body) => {
    if (index === 0) {
      // Codex is running and its keys are set: what it writes now is "later".
      writeLateFiles(ctx);
      toolNames = (body.tools || []).map((t) => t.name || t.type).filter(Boolean);
      if (toolNames.includes('exec_command')) {
        return [{ type: 'function_call', name: 'exec_command', call_id: 'probe', arguments: JSON.stringify({ cmd: script, yield_time_ms: 30000 }) }];
      }
      return [{ type: 'function_call', name: 'shell', call_id: 'probe', arguments: JSON.stringify({ command: ['bash', '-c', script], timeout_ms: 60000 }) }];
    }
    return null;
  });
  // A private seat keeps its own config.toml, so the stub is its provider there.
  await writeFile(join(ctx.home, '.codex', 'config.toml'), [
    'model_provider = "probe"',
    '[model_providers.probe]',
    'name = "probe"',
    `base_url = "http://127.0.0.1:${model.port}/v1"`,
    'env_key = "PROBE_MODEL_KEY"',
    'wire_api = "responses"',
    '',
  ].join('\n'));
  log('\n== turn: one real turn through the adapter, stub model ==');
  const started = Date.now();
  const outcome = await adapter.spawn('run the probe', seatCtx(ctx, { env: { PROBE_MODEL_KEY: 'stub' } }))
    .then((value) => ({ value }), (error) => ({ error }));
  log(`   turn ${outcome.error ? `failed: ${clip(outcome.error.message, 600)}` : 'completed'} in ${Date.now() - started} ms;`
    + ` ${model.requests.length} model requests; tools offered: ${toolNames.join(', ') || '(none seen)'}`);
  const output = model.requests.at(-1)?.input?.find((item) => item.call_id === 'probe' && /output/.test(item.type))?.output;
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  if (!/R done/.test(text)) log(`   shell output: ${clip(text, 800)}`);
  judge('turn: the adapter, real Codex, stub model', parse(text.replace(/\\n/g, '\n')), ctx);
  await model.close();
  await rm(ctx.root, { recursive: true, force: true });
  await rm(ctx.otherTurn, { recursive: true, force: true });
};

const version = spawnSync(CODEX, ['--version'], { encoding: 'utf8' });
const bwrap = spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/', '/', 'true'], { encoding: 'utf8' });
log(`platform ${process.platform}; ${clip(version.stdout || version.error?.message)}; bwrap ${bwrap.status === 0 ? 'starts' : `fails: ${clip(bwrap.stderr || bwrap.error?.message)}`}`);
// The package the adapter came from, read from its own package.json.
const adapterVersion = () => {
  try {
    return JSON.parse(readFileSync(join(dirname(ADAPTER_PATH), '..', '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
};
log(`adapter: ${process.env.PROBE_ADAPTER ? 'published' : 'this checkout'} @commonlyai/cli ${adapterVersion()}, ${ADAPTER_PATH}`);
for (const phase of phases) {
  try {
    if (phase === 'rules') await rules();
    else if (phase === 'keys') await keys();
    else if (phase === 'turn') await turn();
    else throw new Error(`unknown phase ${phase}`);
  } catch (err) {
    failures += 1;
    log(`FAIL ${phase}: ${err.stack || err.message}`);
  }
}
log(`\nRESULT ${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exitCode = failures ? 1 : 0;
// The adapter may leave timers behind; the result is printed.
setTimeout(() => process.exit(process.exitCode), 200).unref();
