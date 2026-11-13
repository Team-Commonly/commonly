/**
 * A seat that can't run a turn goes quiet (2026-11-06).
 *
 * The turn fails, the run loop opens the circuit and retries in 15 minutes, and
 * the only trace is a line in a terminal the person in the pod may not own.
 * They see their @mention go unanswered, with no reason. The wrapper, not the
 * model, posts one plain line instead, since no model turn can run. It names
 * the cause and who can fix it. It never quotes the error text, which is vendor
 * output and can carry key material.
 *
 * The failure classes in spawn-retry.js are too loose for this. They only pick a
 * backoff, so a stray "401" or "billing" in a stack trace costs a slower retry.
 * Here the match becomes a statement to a person, so each line below fires only
 * on a wording a seat has logged, a walk has produced, a vendor publishes, or
 * the wrapper or our own gateway config writes. A failure that matches none of
 * them posts nothing, which is what it did before.
 */
import { PUBLIC_MCP_NOT_READY_CODE, PUBLIC_TOOL_FAILED_CODE } from './public-tool-error.js';
import { PUBLIC_CODEX_VERSION_CODE } from './adapters/tested-version.js';
import { classifySpawnFailure, GATEWAY_BUDGET_RE, SPAWN_FAILURE_CLASS } from './spawn-retry.js';
import { modelUnavailableFailure } from './model-unavailable.js';

/** How long one cause stays posted in a pod before the seat may post it again. */
export const CANT_ANSWER_NOTICE_WINDOW_MS = 60 * 60 * 1000;

const LOGIN_FAILED_WORDINGS = [
  // Not `(upstream 401)` alone: adapterFailure writes that for any "status 401"
  // in a tail, including a tool's stderr. A failed Codex turn is its own report.
  /^codex turn failed \(upstream 401\)/,
  /\bupstream refused 401\b/, // the same refusal, read from pi's stream
  /^\w+ exited(?: with code)? \d+: 401\b/, // pi's text, which names no upstream
  /workspace routing discovery unauthorized/,
  // Any other text carrying Claude Code's wording keeps this general line.
  /(?:^|: | \| )Not logged in · Please run \/login/,
  /API Error: 400 This API key is not scoped to a workspace/,
  // The wrapper's own refusals of a Claude login (adapters/claude.js).
  /the Claude login on this machine expires in/,
  /refusing a Claude login/,
];
// F436: what Claude Code prints, and exits 1 on, when it has no login on the
// computer (2.1.318, walked on windows-latest). No key is wrong and no allowance
// is spent: someone signs in to Claude Code there, and the next turn works.
// Anchored on the claude adapter's own exit line, first in its tail or after
// the stderr | stdout join, because this match acks the message unanswered:
// the same words from another adapter or a tool keep the general login line.
const CLAUDE_SIGNED_OUT_WORDINGS = [
  /^claude exited(?: with code)? \d+: (?:[^\n]*? \| )?Not logged in · Please run \/login/,
];
const WONT_START_WORDINGS = [
  /^spawn \S+ ENOENT/,
  // windows-command.js resolveLaunch: not on PATH, or a .cmd/.ps1 that only a
  // shell can run. The harness never started, as with ENOENT (F262).
  /^cannot launch \S+ on Windows without a shell: /,
  /^\w+ adapter: \S+ (?:is not set|is missing)/, // the seat has no provider key
];
// The vendors' credit wordings open at the adapter's own label or the claude
// adapter's stderr | stdout join, because any `: ` or status number can open a
// log line. An unknown label stays silent. `upstream refused` is the line the run
// loop builds for pi, and the pi adapter puts its label before it when a refused
// turn exits 0 after an interim message (F320). The transports are how a CLI
// wraps a refusal it keeps whole.
const ADAPTER_LABEL = String.raw`(?:claude|codex|pi|opencode|goose|qwen|dsh|Hermes)(?: turn failed)?(?: exited(?: with code)? \d+)?(?: \(upstream \d{3}\))?`;
const OWN_LEAD = String.raw`(?:^(?:${ADAPTER_LABEL}(?:: upstream refused \d{3})?|upstream refused \d{3}): | \| )`;
const TRANSPORT = String.raw`(?:unexpected status \d{3}[^:\n]*: |API Error: \d{3} |Error code: \d{3} - |Error running remote compact task: )*`;
const OPENAI_CODE = '(?:insufficient_quota|credit_balance_exhausted)';
const ownWording = (wording) => new RegExp(`${OWN_LEAD}${TRANSPORT}${wording}`);

// Not the whole of QUOTA_RE, which also holds "billing" and "quota" for backoff.
const OUT_OF_ALLOWANCE_WORDINGS = [
  /(?:^|: | \| )you['’]?ve (?:hit|reached) your [^\n]{0,40}?limit/i,
  /\bout of credits\b/i,
  GATEWAY_BUDGET_RE,
  // An API key with no credit left, in the vendors' published text, case-sensitive.
  // OpenAI's API (openai-cookbook error-codes, codex tests/suite/quota_exceeded.rs).
  ownWording('You exceeded your current quota, please check your plan and billing details'),
  // codex-rs source maps insufficient_quota, credit_balance_exhausted and the
  // spend-limit codes to this text (CodexErr::QuotaExceeded). Not run on a binary.
  ownWording(String.raw`Quota exceeded\. Check your plan and billing details`),
  // OpenAI's error.type and error.code (guides/error-codes): bare, or in a body kept whole.
  ownWording(String.raw`(?:\d{3} )?${OPENAI_CODE}\b`),
  ownWording(String.raw`\{['"]error['"]: ?\{[^{}\n]{0,400}?['"](?:code|type)['"]: ?['"]${OPENAI_CODE}['"]`),
  // Anthropic's API (about-claude/api-credits-for-subscribers): reduced, or in its body.
  ownWording(String.raw`(?:\{"type":"error","error":\{"type":"invalid_request_error","message":")?Your credit balance is too low to access the Anthropic API`),
  // Claude Code: the same page, and its errors page.
  ownWording(String.raw`Credit balance (?:is )?too low(?: ·| \||\n|$)`),
];

const AGAIN = 'After that, send your message again if I still haven’t answered.';

export const LOGIN_NOTICE = 'I can’t answer right now: the key or login on the computer I run on isn’t working. '
  + `Whoever runs me needs to fix it and start me again. ${AGAIN}`;
export const CLAUDE_SIGNED_OUT_NOTICE = 'I can’t answer right now: Claude Code isn’t signed in on the computer I run on. '
  + `Whoever runs me needs to open Claude Code there and sign in. ${AGAIN}`;
// What the seat's own log says, for whoever runs it.
export const CLAUDE_SIGNED_OUT_FIX = 'Claude Code is not signed in on this computer: open Claude Code here and sign in '
  + '(/login). The waiting message was acked, not held, so the next message starts a turn at once.';
export const WONT_START_NOTICE = 'I can’t answer right now: the tool I run on wouldn’t start on my computer. '
  + `Whoever runs me needs to fix that and start me again. ${AGAIN}`;
export const OUT_OF_ALLOWANCE_NOTICE = 'I can’t answer right now: the AI account I run on has used up its allowance. '
  + `It needs to reset, or whoever runs me needs to add more. ${AGAIN}`;

// A turn that had posted, whose event the server had settled, and that then
// stopped. The event won't come back, so this is all the person hears. Hedged,
// because a kill can land after the last word: a checkpoint says the seat
// finished an item, and part one of an answer has been enough to earn one.
// The kernel exempts this exact text from its duplicate guard: change both
// (CUT_OFF_LINE in agentMessageService.ts, pinned by a test).
export const CUT_OFF_NOTICE = 'I got cut off before I could finish that, so please ask me again if anything is missing.';

// F421: a public seat whose Commonly tools never came up. Its model would have
// answered without reading the pod, so the wrapper withholds that answer and
// says this instead; the event stays unacked and is answered once the tools work.
export const TOOLS_UNAVAILABLE_NOTICE = 'I can’t answer right now: the tools I use to read and post here '
  + `aren’t working on my computer. Whoever runs me needs to fix that. ${AGAIN}`;

export const codexVersionNotice = (required) => 'I can’t answer right now: the computer I run on needs '
  + `Codex ${required} or newer. Whoever runs me needs to upgrade it and start me again. ${AGAIN}`;

const matches = (wordings, text) => wordings.some((wording) => wording.test(text));

/** The cause a pod should hear about, and its line, or null when it should hear nothing. */
export const cantAnswerNotice = (error) => {
  // A public seat's withheld turn quotes a TOOL's error, not its own provider's.
  // A tool that failed mid-turn usually means Commonly itself was unreachable,
  // so a line could not reach the pod either; it stays silent and retries.
  if (error?.code === PUBLIC_TOOL_FAILED_CODE) return null;
  // Tools that never started leave the API reachable, and a stranger waiting.
  if (error?.code === PUBLIC_MCP_NOT_READY_CODE) return { cause: 'tools-unavailable', text: TOOLS_UNAVAILABLE_NOTICE };
  if (error?.code === PUBLIC_CODEX_VERSION_CODE) {
    return { cause: 'codex-version', text: codexVersionNotice(error.requiredVersion) };
  }
  // claudeFailureTail drops tool and assistant JSON. This cut is for what can
  // still arrive: a torn stream line, or an error event after stderr.
  const text = String(error?.message ?? '').split(/(?:^|: | \| |\n)\{"type":/)[0];
  // Before the general login line: this one names its own fix.
  if (matches(CLAUDE_SIGNED_OUT_WORDINGS, text)) return { cause: 'claude-signed-out', text: CLAUDE_SIGNED_OUT_NOTICE };
  // Before the allowance check: a 401 is settled, whatever else its body says.
  if (matches(LOGIN_FAILED_WORDINGS, text)) return { cause: 'login', text: LOGIN_NOTICE };
  if (matches(WONT_START_WORDINGS, text)) return { cause: 'wont-start', text: WONT_START_NOTICE };
  if (classifySpawnFailure(error) === SPAWN_FAILURE_CLASS.QUOTA && matches(OUT_OF_ALLOWANCE_WORDINGS, text)) {
    return { cause: 'out-of-allowance', text: OUT_OF_ALLOWANCE_NOTICE };
  }
  return null;
};

// F370 rough spot #11: Settings said "spawn failed" and nothing more; the cause
// was only in the seat's log. The runner reports one of these fixed codes with
// a failed outcome, never the error text. The server stores the code alone.
export const SPAWN_FAILURE_REASONS = [
  'claude-signed-out', 'login', 'wont-start', 'out-of-allowance', 'tools-unavailable', 'codex-version', 'model-unavailable',
];
// A shell's "found but can't run it" exit, on the adapter's own exit line.
const NOT_EXECUTABLE_EXIT = /^\w+ exited(?: with code)? 126\b/;

/** The failed spawn's reason code, or null when no known cause matches. */
export const spawnFailureReason = (error) => {
  if (!error) return null;
  if (modelUnavailableFailure(error)) return 'model-unavailable';
  const cause = cantAnswerNotice(error)?.cause;
  if (SPAWN_FAILURE_REASONS.includes(cause)) return cause;
  return NOT_EXECUTABLE_EXIT.test(String(error.message ?? '')) ? 'wont-start' : null;
};

/**
 * A turn that failed because Claude Code is signed out on this computer (F436).
 * It is a setup fault, not an outage: retrying cannot fix it, and holding the
 * event behind the 15-minute circuit kept the person waiting with no answer.
 * The run loop acks it instead and posts CLAUDE_SIGNED_OUT_NOTICE, and the
 * next event spawns at once, which is the re-probe.
 */
export const isClaudeSignedOut = (error) => cantAnswerNotice(error)?.cause === 'claude-signed-out';

/** The turn result a signed-out turn is acked with: a person's message is handed to another listener. */
export const CLAUDE_SIGNED_OUT_REASON = 'claude-signed-out';
export const claudeSignedOutResult = () => ({
  outcome: 'error',
  refused: { reason: 'delivery-refused' },
  reason: CLAUDE_SIGNED_OUT_REASON,
  details: { failureClass: 'configuration' },
});
