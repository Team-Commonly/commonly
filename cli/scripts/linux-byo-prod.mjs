/**
 * The Linux prod walk (byo-linux.yml): the Bring your own page's Linux lines
 * for Claude Code or Codex (the dispatch's `adapter`), pasted into one bash process on a GitHub-hosted Ubuntu
 * runner against the live API with a real model, as a Linux user would. Only
 * the published CLI is walked (the page's `npx -y @commonlyai/cli@latest` run
 * line, verbatim: that one line fetches the CLI and runs it).
 *
 * The CLI runs a public Claude Code seat in the bubblewrap jail (F96). This
 * walk takes the API-key path: ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL sit in
 * the CLI's environment, and the CLI keeps the key on the host behind its
 * per-turn proxy. The person's-own-login path is not walked here: that would
 * put a personal Claude login into repo secrets.
 *
 * Codex takes the same gateway key, on the gateway's Responses route (the
 * route cloud-codex uses), given as CODEX_API_KEY beside OPENAI_BASE_URL. The
 * CLI keeps the key behind its per-turn proxy and hands codex only the proxy
 * (D250). The agent's saved model must be one the gateway serves there. A
 * person's own ChatGPT login or OpenAI key is not walked.
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
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  describeCause, parseRecorderLog, prodInputs, prodOutcome, redact,
} from './windows-byo-verdict.mjs';

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
    lift(/const CLI_NPX_COMMAND = '[^'\n]*';/, 'CLI_NPX_COMMAND'),
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

/**
 * Where the walk's fresh home goes: beside the runner user's own home, never
 * under the temp dir. Codex refuses to create its sandbox helper binaries
 * under a temp dir ("Refusing to create helper binaries under temporary dir
 * /tmp"), then bwrap cannot exec the helper and every turn fails before the
 * model is called (run 41994410063). A person's home is not in /tmp either.
 */
export const walkHomeRoot = () => homedir();

/**
 * The gateway key and address under the names each adapter reads. Codex takes
 * them as a person would, CODEX_API_KEY beside OPENAI_BASE_URL: the CLI keeps
 * the key on the host behind its per-turn proxy and hands codex only the proxy.
 */
export const walkModelEnv = (adapter, llmKey, gateway) => (adapter === 'codex'
  ? { CODEX_API_KEY: llmKey, OPENAI_BASE_URL: `${gateway}/v1` }
  : { ANTHROPIC_API_KEY: llmKey, ANTHROPIC_BASE_URL: gateway });

/**
 * Codex's system-layer config for the Windows walk (windows-byo-prod.mjs). A
 * public Codex seat runs with --ignore-user-config, which skips
 * $CODEX_HOME/config.toml; the system layer is the one other place to name a
 * provider. The walk's label says so: this is our gateway set system-wide, not
 * a user's own ChatGPT login or OpenAI key.
 *
 * It names the model too. The walk's key allows one alias, and a BYO seat
 * keeps Codex's own default model, which moves between releases: 0.169.0
 * asks for a GPT model the key refuses (403), and the turn never runs.
 */
export const codexSystemConfig = (gateway, model) => {
  if (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new Error('codexSystemConfig: name the model the walk key allows');
  }
  return codexSystemConfigLines(gateway, model);
};

const codexSystemConfigLines = (gateway, model) => [
  `model = "${model}"`,
  'model_provider = "commonly-gateway"',
  '',
  '[model_providers.commonly-gateway]',
  'name = "Commonly model gateway"',
  `base_url = "${gateway}/v1"`,
  'wire_api = "responses"',
  'env_key = "LITELLM_API_KEY"',
  '',
].join('\n');

/** What is wrong with the page's Linux lines for this adapter, if anything. */
export const linuxLineProblems = (lines, {
  agentName, apiUrl, token, adapter = 'claude',
}) => {
  const problems = [];
  if (lines.length !== 3) return [`the page's Linux lines are ${lines.length} lines, not 3: ${JSON.stringify(lines)}`];
  if (lines[0] !== `export COMMONLY_API_URL=${apiUrl}`) problems.push(`line 1 does not set COMMONLY_API_URL: ${lines[0]}`);
  if (lines[1] !== `export COMMONLY_AGENT_TOKEN=${token}`) problems.push('line 2 does not set COMMONLY_AGENT_TOKEN');
  if (lines[2] !== `npx -y @commonlyai/cli@latest agent run ${agentName} --adapter ${adapter}`) {
    problems.push(`line 3 is not a sandboxed ${ADAPTER_LABEL[adapter] || adapter} run through npx: ${lines[2]}`);
  }
  return problems;
};

/**
 * The lines as pasted, with one guard after the run line. That line fetches
 * the CLI through npx and runs it, so it is the page's whole command. A
 * successful walk is stopped while it still runs, so the guard fires only when
 * npx or the CLI exits early, and the walk can name that exit rather than say
 * "never started polling".
 */
export const linuxPasteScript = (lines) => [
  ...lines,
  'status=$?; if [ "$status" -ne 0 ]; then echo "linux-byo-walk: the page\'s command exited $status"; exit 97; fi',
];

/**
 * Whether the CLI would run this agent's turns at workspace trust: every pod
 * it is in reported private, unlisted and invite-only (the CLI's own rule,
 * firstRunWorkspace and placeTurn in agent.js).
 */
export const runsAtWorkspaceTrust = (installations = []) => installations.length > 0
  && installations.every((row) => row?.publicRead === false && row?.communityListed === false
    && row?.joinPolicy === 'invite-only');

/** The page's command's exit code when the guard after it tripped, else null. */
export const commandExitFromBash = (out) => {
  const m = /linux-byo-walk: the page's command exited (\d+)/.exec(String(out || ''));
  return m ? Number(m[1]) : null;
};

/**
 * Why the CLI is not polling: the page's command exited (npx could not fetch
 * the CLI, or the CLI quit before its poll loop), or it never got there.
 */
export const neverPolledProblem = ({
  commandExit = null, api, shell, exited = null, seconds,
}) => (commandExit !== null
  ? `the page's command exited ${commandExit} before the CLI polled ${api}`
  : `the CLI never started polling ${api} (${exited === null ? `${seconds} s` : `${shell} exited ${exited}`})`);

/**
 * The version of @commonlyai/cli that npx fetched, read from npx's own cache
 * (<cache>/_npx/<hash>/node_modules/@commonlyai/cli/package.json), the newest
 * when there are several. A file read, never a second fetch: 'unknown' when
 * there is none.
 */
export const npxCliVersion = (cacheDirs = []) => {
  const found = [];
  cacheDirs.filter(Boolean).forEach((cache) => {
    const root = join(cache, '_npx');
    let entries = [];
    try { entries = readdirSync(root); } catch { return; }
    entries.forEach((entry) => {
      const manifest = join(root, entry, 'node_modules', '@commonlyai', 'cli', 'package.json');
      try {
        const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
        if (version) found.push({ version: String(version), at: statSync(manifest).mtimeMs });
      } catch { /* not this entry */ }
    });
  });
  found.sort((a, b) => b.at - a.at);
  return found[0]?.version || 'unknown';
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
    console.log('::error::linux walk: runs only on a Linux CI runner (it runs the page\'s command against the live API)');
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
  // before the page's command runs or anyone is asked to post.
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

  // The page tells a Linux user to install bubblewrap first. When it can't
  // start a namespace here the walk goes on regardless: what the page's lines
  // then print is what a person on this host sees, and that is the result.
  const probe = spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/', '/', 'true'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    log(`bubblewrap cannot start a sandbox on this runner: ${(probe.stderr || probe.error?.message || '').trim()}`);
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
  const home = mkdtempSync(join(walkHomeRoot(), 'byo-linux-home-'));
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
    fail(neverPolledProblem({
      commandExit: commandExitFromBash(out),
      api: API,
      shell: 'bash',
      exited,
      seconds: Math.round((Date.now() - start) / 1000),
    }));
    dump();
    await stop();
    return 1;
  }
  // npx caches under the walk's fresh home, so the one CLI there is the page's.
  const cliVersion = npxCliVersion([process.env.npm_config_cache, join(home, '.npm')]);
  const readyAt = Date.now();
  log(`published @commonlyai/cli ${cliVersion}, fetched by the page's npx line, is polling ${API}`);
  console.log(`READY: listening in ${podId}`);
  console.log(`::notice::READY: listening in ${podId}. Post the @${agentName} mention now; the walk fails at ${new Date(readyAt + ANSWER_TIMEOUT_MS).toISOString()}.`);

  // Read with `before` set, so this read is not recorded as the agent's own
  // and cannot change what the agent's next post is told it has seen.
  let outcome = null;
  let lastRead = null;
  let lastMessages = [];
  while (Date.now() - readyAt < ANSWER_TIMEOUT_MS && exited === null && !/circuit open; releasing/.test(out)) {
    // eslint-disable-next-line no-await-in-loop
    const page = await api(`/api/agents/runtime/pods/${podId}/messages?limit=20&before=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`)
      .catch((err) => ({ status: 0, body: {}, error: err.message }));
    lastRead = page.error || `HTTP ${page.status}`;
    lastMessages = page.body.messages || lastMessages;
    const recorded = parseRecorderLog(existsSync(ackLog) ? readFileSync(ackLog, 'utf8') : '');
    outcome = prodOutcome({
      messages: lastMessages, agentName, readyAt, events: recorded.events, acks: recorded.acks, output: out,
    });
    if (outcome.passed) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
  }
  const recorded = parseRecorderLog(existsSync(ackLog) ? readFileSync(ackLog, 'utf8') : '');
  // Read once more after the loop: a refusal the CLI logged on its way out still names the cause.
  if (outcome && !outcome.passed) {
    outcome = prodOutcome({
      messages: lastMessages, agentName, readyAt, events: recorded.events, acks: recorded.acks, output: out,
    });
  }
  await stop();
  if (outcome?.passed) {
    const said = String(outcome.reply.content || '');
    log(`@mention ${outcome.mention.id} by ${outcome.mention.username} answered by message ${outcome.reply.id} `
      + `in ${outcome.answerSeconds} s, event ${outcome.ack.eventId} acked HTTP ${outcome.ack.status}`);
    log(`the reply: ${JSON.stringify(said.slice(0, 300))}`);
    // Answered with no working sandbox would be a seat that ran unconfined.
    if (probe.status !== 0) {
      fail('the agent answered, but bubblewrap could not start a sandbox on this runner');
      await stop();
      return 1;
    }
    log(`PASS: published @commonlyai/cli ${cliVersion} on Linux answered an @mention on ${API} with `
      + `${ADAPTER_LABEL[adapter]} in the bubblewrap jail, on an API key through the model gateway`
      + `${adapter === 'codex' ? ' (the key kept on the host behind the CLI\'s per-turn proxy)' : ''}`);
    return 0;
  }
  (outcome?.problems || ['the walk ended before the pod was read']).forEach((problem) => fail(problem));
  if (outcome?.cause) log(describeCause(outcome.cause, ADAPTER_LABEL[adapter]));
  log(`the last read of the pod: ${lastRead || 'none'}`);
  log(`events the CLI was handed: ${JSON.stringify(recorded.events)}`);
  log(`acks the CLI sent: ${JSON.stringify(recorded.acks)}`);
  if (exited !== null) {
    const commandExit = commandExitFromBash(out);
    log(`bash exited ${exited} before the walk finished${commandExit !== null ? ` (the page's command exited ${commandExit})` : ''}`);
  }
  dump();
  return 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(process.argv.includes('--check') ? check() : await runLinuxProdWalk());
}
