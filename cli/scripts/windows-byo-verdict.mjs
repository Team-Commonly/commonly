/**
 * D164: what the Windows Bring-your-own walk fails on. Pure, so it is tested
 * off Windows (cli/__tests__/windows-byo-verdict.test.mjs); the walk itself is
 * windows-byo-smoke.mjs.
 */

// Pasted right after the install line. PowerShell runs the next line whatever
// a native command exits with, so without this a failed install goes on to
// run whichever `commonly` is already on PATH: in this tree's leg, the
// published CLI the first leg installed, which would pass for this checkout.
// `$LASTEXITCODE`, not `$?`: Windows PowerShell can clear `$?` when npm only
// warns on stderr. A missing `npm` leaves it unset, and `commonly` then never
// polls, which fails the leg anyway.
export const INSTALL_GUARD = 'if ($LASTEXITCODE) { Write-Output "windows-byo-smoke: the install line exited $LASTEXITCODE"; exit 97 }';

/** The page's lines as pasted: the install line, the guard, the rest. */
export const pasteScript = (lines) => [lines[0], INSTALL_GUARD, ...lines.slice(1)];

/** The install line's exit code when the guard tripped, else null. */
export const installExitFrom = (out) => {
  const m = /windows-byo-smoke: the install line exited (-?\d+)/.exec(String(out || ''));
  return m ? Number(m[1]) : null;
};

/**
 * Which of a leg's problems fail the check and which are only reported.
 *
 * `reportOnly` is the published leg on a pull request. A CLI fix reaches npm
 * only after it merges, so what the published CLI does once it holds an
 * @mention is reported there and this tree's leg decides. That leg replaces
 * the page's install line, though, so it cannot stand in for it: a published
 * install that fails, or a published CLI that never picks up its @mention,
 * fails the pull request too.
 *
 * @returns {{ fail: string[], warn: string[] }}
 */
export const publishedOutcome = ({ problems = [], installExit = null, delivered = false } = {}, { reportOnly = false } = {}) => {
  const all = installExit === null
    ? [...problems]
    : [`the install line exited ${installExit}`, ...problems];
  if (!all.length) return { fail: [], warn: [] };
  if (reportOnly && installExit === null && delivered) return { fail: [], warn: all };
  return { fail: all, warn: [] };
};

// ── the harness (D250) ────────────────────────────────────────────────────
// Each run walks one harness, named by the dispatch's `harness` input.
export const HARNESS_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });

export const walkHarness = (env = {}) => {
  const harness = String(env.COMMONLY_BYO_HARNESS || 'claude');
  if (!Object.prototype.hasOwnProperty.call(HARNESS_LABELS, harness)) {
    throw new Error(`harness must be claude or codex, got ${JSON.stringify(harness)}`);
  }
  return harness;
};

/**
 * How a public Codex seat reaches a gateway: CODEX_API_KEY beside
 * OPENAI_BASE_URL in the CLI's environment. The CLI keeps the key on the host
 * behind its per-turn proxy, and codex calls `<base>/responses` through it.
 */
export const codexRouteEnv = (gateway, key) => ({
  CODEX_API_KEY: key,
  OPENAI_BASE_URL: `${String(gateway).replace(/\/+$/, '')}/v1`,
});

// ── Codex on native Windows (D250) ────────────────────────────────────────
// A public Codex seat cannot run there: codex-cli 0.162.1's Windows sandbox
// refuses the read denies that keep it out of ~/.commonly and ~/.ssh
// (byo-windows run 41960954496), so `agent run` stops before it saves a token
// or polls and points at WSL 2 (cli/src/lib/sandbox/host-check.js). The
// Windows walk of the page's Codex lines checks that stop instead of a reply.

/** Two phrases of the CLI's refusal (windowsCodexMessage): why, and what to do instead. */
export const CODEX_WINDOWS_REFUSAL = "Codex's own Windows sandbox can't enforce";
export const CODEX_WINDOWS_DIRECTIONS = 'WSL 2 (Ubuntu): install Node and Codex inside WSL';

/** Whether the Windows walk of this harness's lines expects the refusal. */
export const expectsWindowsRefusal = (harness) => harness === 'codex';

/** What is wrong with a Windows leg that should have stopped with the WSL 2 directions. */
export const windowsRefusalProblems = ({ out = '', exited = null, polled = false, seconds = 0 } = {}) => {
  if (polled) return ['Codex polled for @mentions on native Windows instead of stopping with the WSL 2 directions'];
  if (exited === null) return [`the run was still going after ${seconds} s and never printed the WSL 2 directions`];
  const text = String(out);
  if (!text.includes(CODEX_WINDOWS_REFUSAL) || !text.includes(CODEX_WINDOWS_DIRECTIONS)) {
    return ['the run stopped without the WSL 2 directions'];
  }
  if (exited === 0) return ['the run printed the directions but exited 0, which a script reads as success'];
  return [];
};

/** Why a prod dispatch of this harness on Windows has nothing to walk, or null. */
export const windowsProdRefusal = (harness) => (expectsWindowsRefusal(harness)
  ? 'Codex on native Windows stops with the WSL 2 directions before it listens, so a prod walk would wait for a reply'
    + ' that cannot come. Dispatch target=stub to walk that stop, or walk Codex on Linux (byo-linux.yml).'
  : null);

// ── the prod walk (target=prod) ───────────────────────────────────────────
// The page's lines against the live API with a real model. A person in the
// pod posts the @mention; the walk reads the pod with the agent's own token
// and the acks the CLI itself sent (windows-byo-ack-recorder.mjs), because
// the server has no read of an event's state that does not also claim it.

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The dispatch inputs and the two secrets, from the step env. The agent name
 * is pasted into a shell, so each name must be a plain name. `secrets` names
 * the repo secrets in the refusal (the Linux walk reads BYO_LINUX_PROD_*).
 */
export const prodInputs = (env = {}, { secrets = 'BYO_WIN_PROD' } = {}) => {
  const agentName = String(env.COMMONLY_BYO_PROD_AGENT || '');
  const instanceId = String(env.COMMONLY_BYO_PROD_INSTANCE || '');
  const podId = String(env.COMMONLY_BYO_PROD_POD || '');
  const token = String(env.COMMONLY_BYO_PROD_AGENT_TOKEN || '');
  const llmKey = String(env.COMMONLY_BYO_PROD_LLM_KEY || '');
  if (!NAME.test(agentName)) throw new Error('agentName must be a plain agent name');
  if (!NAME.test(instanceId)) throw new Error('instanceId must be a plain instance id');
  if (!/^[a-f0-9]{24}$/.test(podId)) throw new Error('podId must be a 24-character pod id');
  if (!token) throw new Error(`secret ${secrets}_AGENT_TOKEN is empty`);
  if (!llmKey) throw new Error(`secret ${secrets}_LLM_KEY is empty`);
  return { agentName, instanceId, podId, token, llmKey };
};

/** Every non-empty secret in `text`, replaced with ***. */
export const redact = (text, secrets = []) => secrets
  .filter(Boolean)
  .reduce((out, secret) => out.split(secret).join('***'), String(text ?? ''));

/** The recorder's JSON lines. A line still being written is skipped. */
export const parseRecorderLog = (text) => {
  const events = [];
  const acks = [];
  String(text || '').split('\n').forEach((line) => {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row?.kind === 'event') events.push(row);
    else if (row?.kind === 'ack') acks.push(row);
  });
  return { events, acks };
};

const timeOf = (m) => Date.parse(m?.createdAt);
const idOf = (m) => String(m?.id ?? m?._id ?? '');

// The model route refused: the gateway, the model, or the host proxy in front
// of them. Read from the CLI's own words, so a walk on a route no walk has run
// before (Codex through the gateway's Responses bridge, D250) says whose
// failure it was. These are the run loop's lines (cli/src/commands/agent.js):
// a turn left unacked names its failure class, a turn acked as refused names
// its reason, and the host proxy names a route it refused.
// `configuration` is not among them: it also covers a missing binary or login
// (CONFIGURATION_RE in cli/src/lib/spawn-retry.js), so it counts as the model
// route only when the line names an upstream status or a rejected key (the
// key and auth words of CONFIGURATION_RE, which name no binary or login).
const MODEL_FAILURE_CLASSES = new Set(['content_refused', 'quota', 'rate_limit']);
const REJECTED_KEY = /invalid api key|authentication failed|unauthori[sz]ed|forbidden|\b40[13]\b/i;
const isRefusalReason = (reason) => reason === 'provider-refused' || /^upstream-refused/.test(String(reason || ''));

// The CLI stamps its own lines with an ISO time; the proxy's refusals and
// codex's continuation lines carry none. An unstamped line takes the time of
// the stamped line before it, since the walk reads both streams into one
// buffer in arrival order. One with no stamped line before it is kept,
// because nothing places it.
const LINE_STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;
const linesSince = (text, since) => {
  if (!Number.isFinite(since)) return text;
  let lastStamp = null;
  return text.split('\n').filter((line) => {
    const stamp = LINE_STAMP.exec(line);
    if (stamp) lastStamp = Date.parse(stamp[1]);
    return lastStamp === null || lastStamp >= since;
  }).join('\n');
};

/**
 * The turns the CLI's log says failed, with the class and upstream status each
 * named. With `since` (epoch ms), a stamped line from before it is skipped: the
 * output covers the whole run, and an earlier failure was another event's.
 */
export const failedTurnsFrom = (output, { since } = {}) => {
  const text = linesSince(String(output || ''), since);
  const turns = [];
  const failed = /processing failed \(([a-z_]+);[^\n]*/g;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = failed.exec(text)) !== null) {
    const upstream = /\(upstream (\d{3})\)|upstream refused (\d{3})/.exec(m[0]);
    turns.push({
      failureClass: m[1],
      upstreamStatus: upstream ? Number(upstream[1] || upstream[2]) : null,
      rejectedKey: REJECTED_KEY.test(m[0]),
    });
  }
  if (/the model provider refused the content of event/.test(text)) turns.push({ failureClass: 'content_refused', upstreamStatus: null });
  // The host proxy's two refusals (packages/seats/src/wire/provider-proxy.js):
  // a completion for a model the turn didn't pin is the model route's; any
  // other refusal names a method and a path the proxy doesn't serve, which
  // is the harness calling a route the CLI's provider spec lacks.
  if (/provider proxy refused a completion for an unpinned model/.test(text)) {
    turns.push({ failureClass: 'proxy_refused', upstreamStatus: null });
  }
  if (/provider proxy refused (?!a completion for an unpinned model)\S/.test(text)) {
    turns.push({ failureClass: 'proxy_route_refused', upstreamStatus: null });
  }
  return turns;
};

/**
 * Whether the prod walk has passed: a person's @mention of the agent posted
 * after the agent was listening, the agent's own message after it (`self`
 * is the server's mark for the token's own posts), and a 2xx ack for the
 * chat.mention event that carried that message, acked as anything but a
 * refusal (a content refusal's notice in the pod is the CLI's, not a reply).
 *
 * `cause` says whose failure a failed walk was: `model` (the gateway or the
 * model refused, or the host proxy refused an unpinned model), `harness` (the
 * turn failed with no model refusal, including a route the host proxy doesn't
 * serve), or `commonly` (no turn failed, yet the reply or the ack did not
 * happen). Null on a pass, and before anyone has posted the @mention.
 */
export const prodOutcome = ({
  messages = [], agentName, readyAt, events = [], acks = [], output = '',
} = {}) => {
  const handle = `@${agentName}`.toLowerCase();
  const sorted = messages
    .filter((m) => m && Number.isFinite(timeOf(m)))
    .sort((a, b) => timeOf(a) - timeOf(b));
  const mention = sorted.find((m) => m.self !== true && timeOf(m) >= readyAt
    && String(m.content || '').toLowerCase().includes(handle)) || null;
  const reply = mention
    ? sorted.find((m) => m.self === true && timeOf(m) >= timeOf(mention) && idOf(m) !== idOf(mention)) || null
    : null;
  const mentionEvents = mention
    ? events.filter((e) => e.type === 'chat.mention' && String(e.messageId ?? '') === idOf(mention))
    : [];
  const ack = acks.find((a) => a.status >= 200 && a.status < 300
    && mentionEvents.some((e) => e.eventId === a.eventId)) || null;
  const refusedAck = ack && isRefusalReason(ack.reason) ? ack : null;
  const failed = failedTurnsFrom(output, { since: mention ? timeOf(mention) : undefined });
  const modelFailure = failed.find((t) => MODEL_FAILURE_CLASSES.has(t.failureClass)
    || t.failureClass === 'proxy_refused' || t.upstreamStatus !== null
    || (t.failureClass === 'configuration' && t.rejectedKey)) || null;

  const problems = [];
  let cause = null;
  if (mention && refusedAck) {
    cause = 'model';
    // The run loop writes `upstream-refused-undefined` when it saw no status.
    const status = refusedAck.refusedStatus ?? /^upstream-refused-(\d{3})$/.exec(refusedAck.reason)?.[1] ?? 'status unknown';
    problems.push(refusedAck.reason === 'provider-refused'
      ? 'the model provider refused the @mention\'s content, and the CLI acked it as refused: the gateway or model, not Commonly'
      : `the gateway or model refused the turn (upstream ${status}), and the CLI acked it as refused: the model route, not Commonly`);
  } else if (mention && (!reply || !ack) && modelFailure) {
    cause = 'model';
    const named = [modelFailure.failureClass, modelFailure.upstreamStatus !== null ? `upstream ${modelFailure.upstreamStatus}` : null]
      .filter(Boolean).join(', ');
    problems.push(`the gateway or model refused the turn (${named}): the model route, not Commonly`);
  } else if (mention && (!reply || !ack) && failed.length) {
    cause = 'harness';
    problems.push(failed.some((t) => t.failureClass === 'proxy_route_refused')
      ? "the CLI's provider proxy refused a route the harness called: a mismatch between the harness and the CLI's provider route, not the gateway or the model"
      : `the agent's turn failed (${failed[0].failureClass}) without a model refusal: the harness, not Commonly`);
  } else if (mention && (!reply || !ack)) {
    cause = 'commonly';
  }
  if (!mention) problems.push(`no ${handle} mention from a person yet`);
  else if (!reply) problems.push('no reply from the agent after the @mention');
  if (!ack) problems.push('the @mention was never acknowledged');
  return {
    passed: problems.length === 0,
    cause,
    mention,
    reply,
    ack,
    answerSeconds: mention && reply ? Math.round((timeOf(reply) - timeOf(mention)) / 1000) : null,
    problems,
  };
};

/** One line naming a failed walk's cause, for the log. */
export const describeCause = (cause, harnessLabel = 'the harness') => ({
  model: 'verdict: the model route failed (the gateway, the model, or the CLI\'s proxy in front of them), not Commonly',
  harness: `verdict: ${harnessLabel}'s turn failed without a model refusal, not Commonly and not the gateway`,
  commonly: 'verdict: no turn failed, so the missing reply or ack is Commonly\'s delivery',
}[cause] || null);
