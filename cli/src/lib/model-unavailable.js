/**
 * F178 — a turn the model provider refused because the model itself is not
 * available, and the one line the wrapper posts about it.
 *
 * Found on a Growth walk, 2026-11-05: a daemon seat with no server-side model
 * ran claude with a model the person's Anthropic key was not scoped for. Every
 * turn failed with "403 The requested model ... is not available for this API
 * key", the seat log said so, and the pod said nothing. The person saw a silent
 * agent and no way to fix it.
 *
 * The match is deliberately narrow. A 403 or 404 alone is not a model problem:
 * a disabled organization, a revoked key and a wrong route all answer 403/404,
 * and telling that person to change the model would send them the wrong way.
 * So a failure counts only when it carries one of these shapes:
 *
 *   1. claude / Anthropic 403: "... model ... is not available for this API key"
 *   2. OpenAI-style error code `model_not_found` (codex, opencode, LiteLLM)
 *   3. a 404 whose text is model-shaped: Anthropic's `not_found_error` body,
 *      kept as "model: <id>" by the adapter's keep-list, or "The model `<id>`
 *      does not exist", or "model <id> not found".
 *
 * A public seat's withheld-tool error quotes a TOOL's vendor text, not the
 * turn's own provider, so it never counts (public-tool-error.js).
 */
import { PUBLIC_MCP_NOT_READY_CODE, PUBLIC_TOOL_FAILED_CODE } from './public-tool-error.js';

/** How long one model's hint stays posted before the seat may post it again. */
export const MODEL_UNAVAILABLE_HINT_WINDOW_MS = 60 * 60 * 1000;

const NOT_AVAILABLE_FOR_KEY_RE = /\bmodel\b[^\n]{0,160}?\bis not available for (?:this|your) API key\b/i;
const MODEL_NOT_FOUND_CODE_RE = /\bmodel_not_found\b/i;
const MODEL_404_SHAPES = [
  /\bmodel:\s*[`'"]?[\w.:/@-]+/i,
  /\bthe model\b[^\n]{0,120}?\bdoes not exist\b/i,
  /\bmodel\b[^\n]{0,120}?\bnot found\b/i,
];
const STATUS_404_RE = /(?:^|[^\d])404(?!\d)/;

// The model id, when the provider named it. Only this charset is ever echoed
// into a pod, so provider prose and anything redacted (`[redacted]`) cannot be.
const MODEL_NAME_RES = [
  /\brequested model\s+[`'"]?([\w.:/@-]+?)[`'"]?\s+is not available\b/i,
  /\bmodel:\s*[`'"]?([\w.:/@-]+)/i,
  /\bmodel\s+[`'"]([\w.:/@-]+)[`'"]/i,
  /\bmodel\s+([\w.:/@-]+)\s+(?:not found|does not exist)\b/i,
];
// An id read out of prose must look like one ("is", "not" never do); a seat's
// own configured model may be a bare alias such as `sonnet`.
const ID_LIKE_RE = /[\d.:/-]/;
const SAFE_MODEL_RE = /^(?=.*[A-Za-z])[\w.:/@-]{1,100}$/;

const failureText = (error) => [error?.message, error?.stderr, error?.body?.error, error?.body?.message]
  .filter((value) => typeof value === 'string' && value)
  .join('\n');

export const safeModelName = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return SAFE_MODEL_RE.test(text) ? text : null;
};

/**
 * `{ model }` when the failure is a provider saying the model is unavailable,
 * else null. `model` is the id the provider named, then `fallbackModel` (the
 * seat's own setting), then null when neither is known.
 */
export const modelUnavailableFailure = (error, { fallbackModel = null } = {}) => {
  if (!error || error.code === PUBLIC_TOOL_FAILED_CODE || error.code === PUBLIC_MCP_NOT_READY_CODE) return null;
  const text = failureText(error);
  if (!text) return null;
  const is404 = error.status === 404 || STATUS_404_RE.test(text);
  const matched = NOT_AVAILABLE_FOR_KEY_RE.test(text)
    || MODEL_NOT_FOUND_CODE_RE.test(text)
    || (is404 && MODEL_404_SHAPES.some((pattern) => pattern.test(text)));
  if (!matched) return null;
  for (const pattern of MODEL_NAME_RES) {
    const named = safeModelName(pattern.exec(text)?.[1]);
    if (named && ID_LIKE_RE.test(named)) return { model: named };
  }
  return { model: safeModelName(fallbackModel) };
};

/** The one line posted in the pod. */
export const modelUnavailableHint = (model) => (model
  ? `The model provider says ${model} isn't available for this agent. To change it, open the agent's Settings, then Model.`
  : "The model provider says this agent's model isn't available. To change it, open the agent's Settings, then Model.");
