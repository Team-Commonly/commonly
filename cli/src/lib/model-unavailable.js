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
 *   1. claude / Anthropic 403: "... model ... is not available for this API key",
 *      with the 403 attached as the status or on the phrase's own line
 *   2. OpenAI-style error code `model_not_found` (codex, opencode, LiteLLM), as
 *      the structured `providerCode` adapterFailure keeps, not message text
 *   3. a 404 whose text is model-shaped, on the same line or in one JSON
 *      error body: Anthropic's `not_found_error` body,
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
// A status-shaped code only: after a line start, whitespace, `(`, `[`, `:`, `=`,
// `,` or a quote, or straight after HTTP/status/code, and never followed by a
// word character, `.` or `-`. A 403/404 inside a model id (`gpt-404-mini`,
// `claude-403x`) is not a status.
const statusRe = (code) => new RegExp(`(?:^|[\\s(\\[:=,'"\`]|(?:HTTP|status|code)_?)${code}(?![\\w.-])`, 'i');
const STATUS_403_RE = statusRe(403);
const MODEL_404_SHAPES = [
  /\bmodel:\s*[`'"]?[\w.:/@-]+/i,
  /\bthe model\b[^\n]{0,120}?\bdoes not exist\b/i,
  /\bmodel\b[^\n]{0,120}?\bnot found\b/i,
];
const STATUS_404_RE = statusRe(404);
const modelShaped = (text) => MODEL_404_SHAPES.some((pattern) => pattern.test(text));

// A 404 counts only when the status and the model shape are one statement: the
// same line, or one JSON error body. An unrelated 404 on one stderr line must
// not be joined to a model mentioned on another.
const sameLine404 = (text) => text.split('\n').some((line) => STATUS_404_RE.test(line) && modelShaped(line));

const jsonBody404 = (text) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const error = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const is404 = [parsed.status, parsed.code, error.status, error.code]
    .some((value) => String(value) === '404') || error.type === 'not_found_error';
  const message = error.message ?? parsed.message;
  return is404 && typeof message === 'string' && modelShaped(message);
};

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
  // A leading `@` would read as a mention in the pod, and `://` as a link.
  if (text.startsWith('@') || text.includes('://')) return null;
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
  // The key-scope phrase counts only on a 403: the attached status, or a 403 on
  // the phrase's own line. The provider's code counts only as the structured
  // field adapterFailure keeps, never as words in a message.
  const keyScope = NOT_AVAILABLE_FOR_KEY_RE.test(text) && (error.status === 403
    || text.split('\n').some((line) => STATUS_403_RE.test(line) && NOT_AVAILABLE_FOR_KEY_RE.test(line)));
  const matched = keyScope
    || error.providerCode === 'model_not_found'
    || sameLine404(text)
    || jsonBody404(text);
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
