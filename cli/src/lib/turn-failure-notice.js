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
 * on a wording a seat has logged, a walk has produced, or the wrapper or our own
 * gateway config writes. A failure that matches none of them posts nothing,
 * which is what it did before.
 */
import { PUBLIC_MCP_NOT_READY_CODE, PUBLIC_TOOL_FAILED_CODE } from './public-tool-error.js';
import { classifySpawnFailure, GATEWAY_BUDGET_RE, SPAWN_FAILURE_CLASS } from './spawn-retry.js';

/** How long one cause stays posted in a pod before the seat may post it again. */
export const CANT_ANSWER_NOTICE_WINDOW_MS = 60 * 60 * 1000;

const LOGIN_FAILED_WORDINGS = [
  // Not `(upstream 401)` alone: adapterFailure writes that for any "status 401"
  // in a tail, including a tool's stderr. A failed Codex turn is its own report.
  /^codex turn failed \(upstream 401\)/,
  /\bupstream refused 401\b/, // the same refusal, read from pi's stream
  /^\w+ exited(?: with code)? \d+: 401\b/, // pi's text, which names no upstream
  /workspace routing discovery unauthorized/,
  /(?:^|: | \| )Not logged in · Please run \/login/,
  /API Error: 400 This API key is not scoped to a workspace/,
  // The wrapper's own refusals of a Claude login (adapters/claude.js).
  /the Claude login on this machine expires in/,
  /refusing a Claude login/,
];
const WONT_START_WORDINGS = [
  /^spawn \S+ ENOENT/,
  /^\w+ adapter: \S+ (?:is not set|is missing)/, // the seat has no provider key
];
// Not the whole of QUOTA_RE, which also holds "billing" and "quota" for backoff.
const OUT_OF_ALLOWANCE_WORDINGS = [
  /(?:^|: | \| )you['’]?ve (?:hit|reached) your [^\n]{0,40}?limit/i,
  /\bout of credits\b/i,
  GATEWAY_BUDGET_RE,
];

const AGAIN = 'After that, send your message again if I still haven’t answered.';

export const LOGIN_NOTICE = 'I can’t answer right now: the key or login on the computer I run on isn’t working. '
  + `Whoever runs me needs to fix it and start me again. ${AGAIN}`;
export const WONT_START_NOTICE = 'I can’t answer right now: the tool I run on wouldn’t start on my computer. '
  + `Whoever runs me needs to fix that and start me again. ${AGAIN}`;
export const OUT_OF_ALLOWANCE_NOTICE = 'I can’t answer right now: the AI account I run on has used up its allowance. '
  + `It needs to reset, or whoever runs me needs to add more. ${AGAIN}`;

const matches = (wordings, text) => wordings.some((wording) => wording.test(text));

/** The cause a pod should hear about, and its line, or null when it should hear nothing. */
export const cantAnswerNotice = (error) => {
  // A public seat's withheld turn quotes a TOOL's error, not its own provider's.
  if (error?.code === PUBLIC_TOOL_FAILED_CODE || error?.code === PUBLIC_MCP_NOT_READY_CODE) return null;
  // A crashed claude turn keeps assistant and tool JSON lines in its tail, and
  // those are the model's words, or a tool's.
  const text = String(error?.message ?? '').split(/(?:^|: | \| |\n)\{"type":/)[0];
  // Before the allowance check: a 401 is settled, whatever else its body says.
  if (matches(LOGIN_FAILED_WORDINGS, text)) return { cause: 'login', text: LOGIN_NOTICE };
  if (matches(WONT_START_WORDINGS, text)) return { cause: 'wont-start', text: WONT_START_NOTICE };
  if (classifySpawnFailure(error) === SPAWN_FAILURE_CLASS.QUOTA && matches(OUT_OF_ALLOWANCE_WORDINGS, text)) {
    return { cause: 'out-of-allowance', text: OUT_OF_ALLOWANCE_NOTICE };
  }
  return null;
};
