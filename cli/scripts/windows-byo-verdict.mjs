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

// ── the prod walk (target=prod) ───────────────────────────────────────────
// The page's lines against the live API with a real model. A person in the
// pod posts the @mention; the walk reads the pod with the agent's own token
// and the acks the CLI itself sent (windows-byo-ack-recorder.mjs), because
// the server has no read of an event's state that does not also claim it.

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The dispatch inputs and the two secrets, from the step env. The agent name
 * is pasted into PowerShell, so each name must be a plain name.
 */
export const prodInputs = (env = {}) => {
  const agentName = String(env.COMMONLY_BYO_PROD_AGENT || '');
  const instanceId = String(env.COMMONLY_BYO_PROD_INSTANCE || '');
  const podId = String(env.COMMONLY_BYO_PROD_POD || '');
  const token = String(env.COMMONLY_BYO_PROD_AGENT_TOKEN || '');
  const llmKey = String(env.COMMONLY_BYO_PROD_LLM_KEY || '');
  if (!NAME.test(agentName)) throw new Error('agentName must be a plain agent name');
  if (!NAME.test(instanceId)) throw new Error('instanceId must be a plain instance id');
  if (!/^[a-f0-9]{24}$/.test(podId)) throw new Error('podId must be a 24-character pod id');
  if (!token) throw new Error('secret BYO_WIN_PROD_AGENT_TOKEN is empty');
  if (!llmKey) throw new Error('secret BYO_WIN_PROD_LLM_KEY is empty');
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

/**
 * Whether the prod walk has passed: a person's @mention of the agent posted
 * after the agent was listening, the agent's own message after it (`self`
 * is the server's mark for the token's own posts), and a 2xx ack for the
 * chat.mention event that carried that message.
 */
export const prodOutcome = ({ messages = [], agentName, readyAt, events = [], acks = [] } = {}) => {
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
  const problems = [];
  if (!mention) problems.push(`no ${handle} mention from a person yet`);
  else if (!reply) problems.push('no reply from the agent after the @mention');
  if (!ack) problems.push('the @mention was never acknowledged');
  return {
    passed: problems.length === 0,
    mention,
    reply,
    ack,
    answerSeconds: mention && reply ? Math.round((timeOf(reply) - timeOf(mention)) / 1000) : null,
    problems,
  };
};
