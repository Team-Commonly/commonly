/**
 * Which failed Commonly tool calls a public seat's model may answer in plain
 * words. Everything else withholds the turn (#2374, Vera 79595, Wren 79596).
 *
 * The rule is inverted on purpose. Matching known connection failures let an
 * API 5xx through: the shipped MCP turns a non-2xx into a tool error carrying
 * the status, and during a rollout the ingress answers 503 while the socket
 * connects, so the model narrated the outage to a stranger. A list of failures
 * fails open on the next one nobody listed; a list of answers fails closed.
 *
 * The answerable ones:
 * - an API refusal the person can be told about: 400, 403, 404, 409, 410, 413
 *   or 422. 401 is NOT among them: a seat whose token the API rejects is
 *   broken plumbing, and every later call fails the same way.
 * - the runtime's own schema check, which the model fixes on its next call.
 *   OpenCode 1.19.0 words it "The <tool> tool was called with invalid
 *   arguments: …" (ToolInvalidArgumentsError, read from the shipped binary).
 *
 * Everything else withholds: a 5xx, 401, 429 or any other status; a tool error
 * with no status (the shipped MCP's network, timeout and token failures); an
 * MCP transport error ("MCP error -32000: Connection closed"); an empty error;
 * and any text this module does not recognise.
 *
 * How the status arrives: the shipped MCP answers a failed call with
 * `isError: true` and one text part, `JSON.stringify({ status, body, message })`
 * for an HTTP error or `{ message }` otherwise (commonly-mcp/src/tools.js,
 * `err`). OpenCode throws that text as the tool's error, so the event's
 * `state.error` is the JSON (measured on the 2026-10-21 canary).
 *
 * The TASK-256 readiness witness uses this same predicate, so the two
 * witnesses cannot disagree about what counts as a failure.
 */

export const ANSWERABLE_API_STATUSES = new Set([400, 403, 404, 409, 410, 413, 422]);

const INVALID_ARGUMENTS_RE = /^The \S+ tool was called with invalid arguments: /;

const parsePayload = (text) => {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Whether a failed tool call's error text is one the model may answer. */
export const isAnswerableToolError = (error) => {
  const text = typeof error === 'string' ? error.trim() : '';
  if (!text) return false;
  if (INVALID_ARGUMENTS_RE.test(text)) return true;
  const payload = parsePayload(text);
  return Boolean(payload && Number.isInteger(payload.status) && ANSWERABLE_API_STATUSES.has(payload.status));
};
