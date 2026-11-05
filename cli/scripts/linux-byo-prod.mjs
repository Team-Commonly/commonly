/**
 * The Linux prod walk (byo-linux.yml): the Bring your own page's Linux lines
 * for Claude Code or Codex (the dispatch's `adapter`), pasted into one bash process on a GitHub-hosted Ubuntu
 * runner against the live API with a real model, as a Linux user would. Only
 * the published CLI is walked (the page's `@latest` install line, verbatim).
 *
 * The CLI runs a public Claude Code seat in the bubblewrap jail (F96). This
 * walk takes the API-key path: ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL sit in
 * the CLI's environment, and the CLI keeps the key on the host behind its
 * per-turn proxy. The person's-own-login path is not walked here: that would
 * put a personal Claude login into repo secrets.
 *
 * Codex takes the same path through the same gateway: its public seat skips
 * config.toml (`--ignore-user-config`) but keeps its environment, so the key
 * and the gateway reach Codex's built-in provider as CODEX_API_KEY and
 * OPENAI_BASE_URL (the gateway's Responses route, as cloud-codex uses). The
 * agent's saved model must be one the gateway serves on that route. A
 * person's own ChatGPT login is not walked, for the same reason.
 *
 * The run does not post the @mention. When the CLI is polling, it logs
 * `READY: listening in <podId>`, and someone in the pod posts the @mention.
 * It passes when the agent's reply appears in the pod after that mention and
 * the CLI has acked the mention's event; it fails 10 minutes after READY.
 *
 * The model is the agent's saved model (Settings, or `commonly agent config
 * <name> --model`): a public seat's environment is an allowlist that drops
 * ANTHROPIC_MODEL, so it must name a model the gateway key allows. Claude
 * Code's small side calls keep their default model names, so a key that
 * allows one alias may refuse some of them; the dump shows those even on a
 * pass. The proxy sends the key upstream as x-api-key.
 *
 * The API key reaches the model only on a public turn. When every pod the
 * agent is in is private and invite-only, the CLI runs the turn at workspace
 * trust, which uses a copied login and drops ANTHROPIC_API_KEY, so the walk
 * refuses such an agent up front rather than fail later as "Not logged in".
 *
 * Fixed here, not inputs: the API and the model gateway. The agent token and
 * the gateway key come from the step env and are never logged: every line
 * this prints passes through redact().
 *
 * `--check` reads the page's Linux lines and checks their shape, with no
 * secrets and no network: that is the pull-request leg.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { parseRecorderLog, prodInputs, prodOutcome, redact } from './windows-byo-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.commonly.me';
const MODEL_GATEWAY = 'https://litellm.commonly.me';
const READY_TIMEOUT_MS = 8 * 60_000;
const ANSWER_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 10_000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * connectSnippet and the helpers it uses, lifted out of the component and run
 * as plain JS, as windows-byo-smoke.mjs does. Throws naming the piece that
 * moved.
 */
export const liftConnectSnippet = (pageSource) => {
  const source = String(pageSource).replace(/\r\n/g, '\n');
  const lift = (re, what) => {
    const m = re.exec(source);
    if (!m) throw new Error(`${what} not found in V2AgentBYO.tsx in the shape this script reads`);
    return m[0];
  };
  // eslint-disable-next-line no-new-func
  return new Function([
    lift(/const CLI_INSTALL_COMMAND = '[^'\n]*';/, 'CLI_INSTALL_COMMAND'),
    lift(/const POWERSHELL_SPECIAL = \/[^\n]*\/g;/, 'POWERSHELL_SPECIAL'),
    lift(/export const powerShellQuote = \(value: string\): string => [^\n]*;/, 'powerShellQuote')
      .replace(/^export /, '').replace('(value: string): string =>', '(value) =>'),
    lift(/export const connectSnippet = \(\{[\s\S]*?\n\};\n/, 'connectSnippet')
      .replace(/^export /, '').replace(/\}: \{[^}]*\}\): string => \{/, '}) => {'),
    'return connectSnippet;',
  ].join('\n'))();
};

const ADAPTERS = ['claude', 'codex'];
const ADAPTER_LABEL = { claude: 'Claude Code', codex: 'Codex' };

/** The adapter the dispatch walks: Claude Code unless it names Codex. */
export const walkAdapter = (env) => {
  const adapter = String(env.COMMONLY_BYO_PROD_ADAPTER || 'claude');
  if (!ADAPTERS.includes(adapter)) throw new Error(`adapter must be claude or codex, not ${adapter}`);
  return adapter;
};

/** The gateway key and address, under the names each adapter reads. */
export const walkModelEnv = (adapter, llmKey, gateway) => (adapter === 'codex'
  ? { CODEX_API_KEY: llmKey, OPENAI_BASE_URL: `${gateway}/v1` }
  : { ANTHROPIC_API_KEY: llmKey, ANTHROPIC_BASE_URL: gateway });

/** What is wrong with the page's Linux lines for this adapter, if anything. */
export const linuxLineProblems = (lines, {
  agentName, apiUrl, token, adapter = 'claude',
}) => {
  const problems = [];
  if (lines.length !== 4) return [`the page's Linux lines are ${lines.length} lines, not 4: ${JSON.stringify(lines)}`];
  if (!/^npm i -g \S+$/.test(lines[0])) problems.push(`line 1 is not an npm install: ${lines[0]}`);
  if (lines[1] !== `export COMMONLY_API_URL=${apiUrl}`) problems.push(`line 2 does not set COMMONLY_API_URL: ${lines[1]}`);
  if (lines[2] !== `export COMMONLY_AGENT_TOKEN=${token}`) problems.push('line 3 does not set COMMONLY_AGENT_TOKEN');
  if (lines[3] !== `commonly agent run ${agentName} --adapter ${adapter}`) {
    problems.push(`line 4 is not a sandboxed ${ADAPTER_LABEL[adapter] || adapter} run: ${lines[3]}`);
  }
  return problems;
};

/**
 * The lines as pasted, with one guard: a failed install stops the paste, so
 * the walk can say the install failed rather than "never started polling".
 */
export const linuxPasteScript = (lines) => [
  lines[0],
  'status=$?; if [ "$status" -ne 0 ]; then echo "linux-byo-walk: the install line exited $status"; exit 97; fi',
  ...lines.slice(1),
];

/**
 * Whether the CLI would run this agent's turns at workspace trust: every pod
 * it is in reported private, unlisted and invite-only (the CLI's own rule,
 * firstRunWorkspace and placeTurn in agent.js).
 */
export const runsAtWorkspaceTrust = (installations = []) => installations.length > 0
  && installations.every((row) => row?.publicRead === false && row?.communityListed === false
    && row?.joinPolicy === 'invite-only');

export const installExitFromBash = (out) => {
  const m = /linux-byo-walk: the install line exited (\d+)/.exec(String(out || ''));
  return m ? Number(m[1]) : null;
};

const pageSnippet = () => liftConnectSnippet(
  readFileSync(resolve(HERE, '../../frontend/src/v2/components/V2AgentBYO.tsx'), 'utf8'),
);

const check = () => {
  let failed = 0;
  ADAPTERS.forEach((adapter) => {
    const sample = {
      agentName: 'linux-walk', apiUrl: API, token: 'cm_agent_linux_walk_check', adapter,
    };
    const lines = pageSnippet()({ os: 'linux', ...sample }).split('\n');
    const problems = linuxLineProblems(lines, sample);
    problems.forEach((p) => console.log(`::error::linux walk check (${adapter}): ${p}`));
    if (!problems.length) console.log(`the page's Linux lines for ${ADAPTER_LABEL[adapter]} have the shape the walk pastes:\n  ${lines.join('\n  ').replace(sample.token, '***')}`);
    failed += problems.length;
  });
  return failed ? 1 : 0;
};

export const runLinuxProdWalk = async () => {
  if (process.platform !== 'linux' || !process.env.CI) {
    console.log('::error::linux walk: runs only on a Linux CI runner (it installs global npm packages)');
    return 2;
  }
  let inputs;
  let adapter;
  try {
    inputs = prodInputs(process.env, { secrets: 'BYO_LINUX_PROD' });
    adapter = walkAdapter(process.env);
  } catch (err) {
    console.log(`::error::linux walk: ${err.message}`);
    return 1;
  }
  const { agentName, instanceId, podId, token, llmKey } = inputs;
  const secrets = [token, llmKey];
  const log = (line) => console.log(redact(`${new Date().toISOString()} ${line}`, secrets));
  const fail = (line) => console.log(redact(`::error::linux walk: ${line}`, secrets));

  const api = async (path) => {
    const res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'commonly-byo-linux-walk/1' },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };

  // The token must be the agent the dispatch names, installed in its pod,
  // before anything is installed or anyone is asked to post.
  const who = await api('/api/agents/runtime/installations')
    .catch((err) => ({ status: 0, body: {}, error: err.message }));
  if (who.status !== 200) {
    fail(`the agent token was refused by ${API} (${who.error || `HTTP ${who.status}`})`);
    return 1;
  }
  const pods = (who.body.installations || []).map((row) => String(row.podId || ''));
  if (who.body.agentName !== agentName || (who.body.instanceId || 'default') !== instanceId || !pods.includes(podId)) {
    fail(`the agent token is ${who.body.agentName}/${who.body.instanceId || 'default'} in pods [${pods.join(', ')}], `
      + `not ${agentName}/${instanceId} in ${podId}`);
    return 1;
  }
  log(`agent token is ${agentName}/${instanceId}, installed in ${podId}`);
  if (runsAtWorkspaceTrust(who.body.installations || [])) {
    fail('every pod this agent is in is private and invite-only, so the CLI would run it on a copied login, '
      + 'not the API key this walk gives it. Walk it in a pod open to join or publicly readable.');
    return 1;
  }

  // The page tells a Linux user to install bubblewrap first; the CLI refuses
  // without a working one. Starting one empty namespace is the real check.
  const probe = spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/', '/', 'true'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    fail(`bubblewrap cannot start a sandbox on this runner: ${(probe.stderr || probe.error?.message || '').trim()}`);
    return 1;
  }

  const lines = pageSnippet()({
    os: 'linux', apiUrl: API, token, agentName, adapter,
  }).split('\n');
  const problems = linuxLineProblems(lines, {
    agentName, apiUrl: API, token, adapter,
  });
  if (problems.length) {
    problems.forEach(fail);
    return 1;
  }
  const script = linuxPasteScript(lines);
  // A fresh home: no Claude or Codex login on it, so the CLI takes the API-key path.
  const home = mkdtempSync(join(tmpdir(), 'byo-linux-home-'));
  const ackLog = join(mkdtempSync(join(tmpdir(), 'byo-linux-acks-')), 'acks.jsonl');
  log(`pasting into bash, home ${home}:\n  ${script.join('\n  ')}`);

  const env = {
    ...process.env,
    HOME: home,
    ...walkModelEnv(adapter, llmKey, MODEL_GATEWAY),
    DISABLE_AUTOUPDATER: '1',
    NODE_OPTIONS: `--import=${pathToFileURL(resolve(HERE, 'windows-byo-ack-recorder.mjs')).href}`,
    COMMONLY_BYO_ACK_LOG: ackLog,
  };
  // The token reaches the CLI through the page's own line, the key under the
  // adapter's own name; neither rides under its secret's name as well.
  delete env.COMMONLY_BYO_PROD_AGENT_TOKEN;
  delete env.COMMONLY_BYO_PROD_LLM_KEY;
  const child = spawn('bash', ['--noprofile', '--norc', '-c', script.join('\n')], {
    cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let out = '';
  // The banner and the dump need only the recent output.
  const keep = (c) => { out = (out + c.toString('utf8')).slice(-200_000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('close', (code) => { exited = code; });
  // SIGTERM first, so the CLI's own shutdown reaps the turn it runs in its
  // own process group; then SIGKILL whatever is left of bash's group. The
  // runner's teardown ends anything that survives both.
  const stop = async () => {
    const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    if (exited === null) {
      signal('SIGTERM');
      for (let i = 0; i < 10 && exited === null; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }
      if (exited === null) signal('SIGKILL');
    }
    rmSync(home, { recursive: true, force: true });
  };
  const dump = () => log(`bash output (last 6000 chars):\n${out.slice(-6000)}`);

  const start = Date.now();
  const polling = () => out.includes(`polling ${API} for events`);
  while (Date.now() - start < READY_TIMEOUT_MS && exited === null && !polling()) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  if (!polling()) {
    const installExit = installExitFromBash(out);
    fail(installExit !== null
      ? `the page's install line exited ${installExit}`
      : `the CLI never started polling ${API} (${exited === null ? `${Math.round((Date.now() - start) / 1000)} s` : `bash exited ${exited}`})`);
    dump();
    await stop();
    return 1;
  }
  const version = spawnSync('npm', ['ls', '-g', '--depth=0', '--json', '@commonlyai/cli'], { encoding: 'utf8' });
  let cliVersion = 'unknown';
  try { cliVersion = JSON.parse(version.stdout).dependencies['@commonlyai/cli'].version; } catch { /* reported as unknown */ }
  const readyAt = Date.now();
  log(`published @commonlyai/cli ${cliVersion}, installed by the page's line, is polling ${API}`);
  console.log(`READY: listening in ${podId}`);
  console.log(`::notice::READY: listening in ${podId}. Post the @${agentName} mention now; the walk fails at ${new Date(readyAt + ANSWER_TIMEOUT_MS).toISOString()}.`);

  // Read with `before` set, so this read is not recorded as the agent's own
  // and cannot change what the agent's next post is told it has seen.
  let outcome = null;
  let lastRead = null;
  while (Date.now() - readyAt < ANSWER_TIMEOUT_MS && exited === null && !/circuit open; releasing/.test(out)) {
    // eslint-disable-next-line no-await-in-loop
    const page = await api(`/api/agents/runtime/pods/${podId}/messages?limit=20&before=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`)
      .catch((err) => ({ status: 0, body: {}, error: err.message }));
    lastRead = page.error || `HTTP ${page.status}`;
    const recorded = parseRecorderLog(existsSync(ackLog) ? readFileSync(ackLog, 'utf8') : '');
    outcome = prodOutcome({
      messages: page.body.messages || [], agentName, readyAt, events: recorded.events, acks: recorded.acks,
    });
    if (outcome.passed) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
  }
  const recorded = parseRecorderLog(existsSync(ackLog) ? readFileSync(ackLog, 'utf8') : '');
  await stop();
  if (outcome?.passed) {
    const said = String(outcome.reply.content || '');
    log(`@mention ${outcome.mention.id} by ${outcome.mention.username} answered by message ${outcome.reply.id} `
      + `in ${outcome.answerSeconds} s, event ${outcome.ack.eventId} acked HTTP ${outcome.ack.status}`);
    log(`the reply: ${JSON.stringify(said.slice(0, 300))}`);
    log(`PASS: published @commonlyai/cli ${cliVersion} on Linux answered an @mention on ${API} with `
      + `${ADAPTER_LABEL[adapter]} in the bubblewrap jail, on an API key through the model gateway`);
    return 0;
  }
  (outcome?.problems || ['the walk ended before the pod was read']).forEach((problem) => fail(problem));
  log(`the last read of the pod: ${lastRead || 'none'}`);
  log(`events the CLI was handed: ${JSON.stringify(recorded.events)}`);
  log(`acks the CLI sent: ${JSON.stringify(recorded.acks)}`);
  if (exited !== null) log(`bash exited ${exited} before the walk finished`);
  dump();
  return 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(process.argv.includes('--check') ? check() : await runLinuxProdWalk());
}
