/**
 * D164 prod walk (byo-windows.yml, target=prod): the Bring your own page's
 * Windows lines for Claude Code, pasted into one PowerShell process against
 * the live API with a real model, as a Windows user would. Only the published
 * CLI is walked (the page's `@latest` install line, verbatim).
 *
 * The run does not post the @mention. When the CLI is polling, it logs
 * `READY: listening in <podId>`, and a person in the pod posts the @mention.
 * It passes when the agent's reply appears in the pod after that mention and
 * the CLI has acked the mention's event; it fails 10 minutes after READY.
 *
 * Fixed here, not inputs: the API (https://api.commonly.me), the model
 * gateway (https://litellm.commonly.me) and the model alias. The agent token
 * and the gateway key come from the step env and are never logged: every
 * line this prints passes through redact().
 *
 * The model route sits in Claude Code's machine-wide managed settings, the
 * same place the stub walk names its stub: a public seat's environment is an
 * allowlist that drops ANTHROPIC_*. On a person's machine that is their own
 * sign-in. The file holds the gateway key, so it is deleted when the walk ends.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  installExitFrom, parseRecorderLog, pasteScript, prodInputs, prodOutcome, redact,
} from './windows-byo-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.commonly.me';
const MODEL_GATEWAY = 'https://litellm.commonly.me';
const MODEL = 'claude-haiku-5-5';
const READY_TIMEOUT_MS = 8 * 60_000;
const ANSWER_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 10_000;
const MANAGED_DIRS = ['C:\\Program Files\\ClaudeCode', 'C:\\ProgramData\\ClaudeCode'];
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export const runProdWalk = async ({ pageConnectSnippet }) => {
  let inputs;
  try {
    inputs = prodInputs(process.env);
  } catch (err) {
    console.log(`::error::prod walk: ${err.message}`);
    return 1;
  }
  const { agentName, instanceId, podId, token, llmKey } = inputs;
  const secrets = [token, llmKey];
  const log = (line) => console.log(redact(`${new Date().toISOString()} ${line}`, secrets));
  const fail = (line) => console.log(redact(`::error::prod walk: ${line}`, secrets));

  const api = async (path) => {
    const res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'commonly-byo-windows-walk/1' },
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

  const managed = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: MODEL_GATEWAY,
      ANTHROPIC_AUTH_TOKEN: llmKey,
      // The key allows this one alias; every model Claude Code may ask for
      // is named as it, so none of its calls is refused for the model.
      ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    },
  }, null, 2);
  MANAGED_DIRS.forEach((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'managed-settings.json'), managed);
  });
  const forgetKey = () => MANAGED_DIRS.forEach((dir) => rmSync(join(dir, 'managed-settings.json'), { force: true }));

  const lines = pageConnectSnippet({ os: 'windows', apiUrl: API, token, agentName, adapter: 'claude' }).split('\n');
  if (lines.length !== 4 || !/^npm i -g \S+$/.test(lines[0]) || !/^commonly agent run /.test(lines[3])) {
    fail(`the page's Windows lines changed shape: ${JSON.stringify(lines)}`);
    forgetKey();
    return 1;
  }
  const script = pasteScript(lines);
  const profile = mkdtempSync(join(tmpdir(), 'byo-prod-profile-'));
  const ackLog = join(mkdtempSync(join(tmpdir(), 'byo-prod-acks-')), 'acks.jsonl');
  log(`pasting into PowerShell, profile ${profile}:\n  ${script.join('\n  ')}`);

  const env = {
    ...process.env,
    USERPROFILE: profile,
    HOME: profile,
    NODE_OPTIONS: `--import=${pathToFileURL(resolve(HERE, 'windows-byo-ack-recorder.mjs')).href}`,
    COMMONLY_BYO_ACK_LOG: ackLog,
  };
  // The token reaches the CLI through the page's own line; neither secret
  // rides in the environment as well.
  delete env.COMMONLY_BYO_PROD_AGENT_TOKEN;
  delete env.COMMONLY_BYO_PROD_LLM_KEY;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script.join('\n')], {
    cwd: profile, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString('utf8'); });
  child.stderr.on('data', (c) => { out += c.toString('utf8'); });
  let exited = null;
  child.on('close', (code) => { exited = code; });
  const stop = () => {
    if (exited === null) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
    forgetKey();
  };
  const dump = () => log(`PowerShell output (last 6000 chars):\n${out.slice(-6000)}`);

  // Listening: the CLI's banner that it is polling the live API.
  const start = Date.now();
  const polling = () => out.includes(`polling ${API} for events`);
  while (Date.now() - start < READY_TIMEOUT_MS && exited === null && !polling()) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  if (!polling()) {
    const installExit = installExitFrom(out);
    fail(installExit !== null
      ? `the page's install line exited ${installExit}`
      : `the CLI never started polling ${API} (${exited === null ? `${Math.round((Date.now() - start) / 1000)} s` : `PowerShell exited ${exited}`})`);
    dump();
    stop();
    return 1;
  }
  const version = spawnSync('npm', ['ls', '-g', '--depth=0', '--json', '@commonlyai/cli'], { encoding: 'utf8', shell: true });
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
  stop();
  if (outcome?.passed) {
    const said = String(outcome.reply.content || '');
    log(`@mention ${outcome.mention.id} by ${outcome.mention.username} answered by message ${outcome.reply.id} `
      + `in ${outcome.answerSeconds} s, event ${outcome.ack.eventId} acked HTTP ${outcome.ack.status}`);
    log(`the reply${/windows-ok/i.test(said) ? ' says windows-ok' : ' does not say windows-ok'}: ${JSON.stringify(said.slice(0, 300))}`);
    log(`PASS: published @commonlyai/cli ${cliVersion} on Windows answered an @mention on ${API} with Claude Code`);
    return 0;
  }
  (outcome?.problems || ['the walk ended before the pod was read']).forEach((problem) => fail(problem));
  log(`the last read of the pod: ${lastRead || 'none'}`);
  log(`events the CLI was handed: ${JSON.stringify(recorded.events)}`);
  log(`acks the CLI sent: ${JSON.stringify(recorded.acks)}`);
  if (exited !== null) log(`PowerShell exited ${exited} before the walk finished`);
  dump();
  return 1;
};
