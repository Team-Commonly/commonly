/**
 * TASK-096 — name a refused model route, instead of reporting the silence it
 * causes.
 *
 * Measured 2026-09-22 against pi 0.84.1 with a route answering 429 (the shape
 * that made a seat look broken for two and a half days): pi runs its own retry
 * ladder, reports the refusal on `message_end`/`auto_retry_end` JSON events, and
 * EXITS 0 with no assistant text. `extractReply` in the pi adapter collected only
 * `type: "error"` events — of which this produces none — so the wrapper logged
 * `no wrapper-post (empty output)` and the cause sat unread in the stream.
 *
 * Two rules govern the text that reaches a seat log:
 *
 *  1. KEEP-LIST, not strip-list (Vera 70876, Wren 70877). A strip-list removes
 *     only the shapes we thought of, and a 401 can echo the key back. So a body
 *     contributes one NAMED field or nothing at all.
 *  2. Exact-match refusal for credentials. If the kept text contains a value
 *     this spawn was handed, the text is dropped — a known value, not a guessed
 *     shape (Wren 70877).
 *
 * Two limits follow from rule 2. They are the accepted cost of refusing guessed
 * shapes, named here so they are not rediscovered as defects later (Vera 71082):
 *
 *  a. The match is exact and against THIS spawn's values only, so a credential
 *     that arrives transformed — base64 inside a proxy error, percent-encoded in
 *     a URL echo — does not match and the text is kept. Matching transformed
 *     shapes instead would reintroduce the class rule 1 exists to avoid.
 *  b. The keep-list can still surface someone ELSE's secret. A third party's key
 *     relayed in an upstream error is not detectable here, because the one
 *     inventory this module has is the set of values it was itself handed.
 *
 * Scope: this reader is wired into the pi adapter only. codex and claude are NOT
 * silent the way pi was: the claude adapter rejects on a non-zero exit and
 * deliberately reports stdout with it, because a `-p` run writes quota
 * conditions there; the codex adapter rejects on `turnFailedMessage` even at
 * exit 0. Their gap is the opposite one — the text they raise is the raw tail,
 * unscrubbed by the rules above, and carries no HTTP status for the run loop to
 * key a refusal on. Extending this module to them is adapter work (TASK-103),
 * not a line in this comment.
 */

/** The kept detail is truncated, ellipsis included, to this many characters. */
export const MAX_REFUSAL_DETAIL = 256;

/**
 * The status an adapter prefixes to its error text: `"429: {…}"` -> `429`.
 * Null for anything that is not a 4xx/5xx, so a message that merely starts with
 * a number ("4040 tokens over budget") is not read as a status.
 *
 * The separator pi uses is NOT fixed — measured 2026-09-22, the same pi 0.84.1
 * emits `"429: {"message":…}"` for a JSON body and `"502 <html>…"` for an
 * HTML one. Both forms are matched here; a parser that required the colon would
 * have kept `502 <html>…` as the whole "body" and then dropped it as non-JSON,
 * reporting the status alone with no sign that the body was never read.
 */
const STATUS_PREFIX = /^\s*(\d{3})(?!\d)\s*:?\s*/;

export const statusFromError = (value) => {
  const match = STATUS_PREFIX.exec(String(value ?? ''));
  if (!match) return null;
  const status = Number(match[1]);
  return status >= 400 && status <= 599 ? status : null;
};

/**
 * The body the adapter carried after its status prefix, or the whole text when
 * there is no status to strip. `"429: {"message":"a: b"}"` -> `{"message":"a: b"}`;
 * `"502 <html>"` -> `<html>`.
 */
export const bodyFromError = (value) => {
  const text = String(value ?? '');
  if (statusFromError(text) === null) return text.trim();
  return text.replace(STATUS_PREFIX, '').trim();
};

/**
 * Replace credential values this spawn was handed with a marker.
 *
 * This is the exact-match half, for text that is kept for its whole shape rather
 * than filtered to one field — an adapter's stderr tail, say, whose diagnostic
 * value is in the lines around the secret. Values shorter than eight characters
 * are ignored: redacting a one-character "credential" would corrupt ordinary
 * prose, and no issued credential is that short.
 */
export const redactKnownCredentials = (text, credentials = []) => {
  let out = String(text ?? '');
  for (const value of credentials) {
    if (typeof value !== 'string' || value.length < 8) continue;
    out = out.split(value).join('[redacted]');
  }
  return out;
};

/**
 * The keep-list. Given the raw body an adapter captured, keep at most one named
 * field of it and only when that field is a string:
 *
 *   `error.message` first (the OpenAI-shaped error), then a top-level `message`
 *   (which is the shape LiteLLM's budget refusal actually uses — the motivating
 *   case; a keep-list that kept only `error.message` would name the status and
 *   still hide the budget line that started this row).
 *
 * Everything else — HTML, a non-JSON body, a JSON body with neither field, a
 * body echoing a known credential — contributes nothing. Returns null rather
 * than a partial guess.
 */
export const keptRefusalDetail = (raw, { credentials = [] } = {}) => {
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? ''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const candidate = parsed?.error?.message ?? parsed?.message;
  if (typeof candidate !== 'string') return null;

  const text = candidate.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const redacted = redactKnownCredentials(text, credentials);
  // `[redacted]` appearing is the signal that the body echoed something this
  // spawn was handed. The status is still worth keeping; the text is not.
  if (redacted !== text) return null;

  return text.length > MAX_REFUSAL_DETAIL
    ? `${text.slice(0, MAX_REFUSAL_DETAIL - 1)}…`
    : text;
};

/**
 * Read a pi JSON stream and return the refusal it ended on, or null.
 *
 * `auto_retry_end` is the terminal word — it names the status and the body after
 * the ladder has finished — so it wins over the per-attempt `message_end`
 * events that precede it. A run that refused on its first attempt and never
 * retried still reports through `message_end`.
 */
export const readUpstreamRefusal = (stdout, { credentials = [] } = {}) => {
  let status = null;
  let raw = null;

  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.type === 'auto_retry_end' && event.success === false) {
      const candidate = event.finalError ?? event.errorMessage;
      const attemptStatus = statusFromError(candidate);
      if (attemptStatus) {
        status = attemptStatus;
        raw = bodyFromError(candidate);
      }
      continue;
    }

    const message = event?.message;
    if (
      event?.type === 'message_end'
      && message?.role === 'assistant'
      && message.stopReason === 'error'
      && status === null
    ) {
      const attemptStatus = statusFromError(message.errorMessage);
      if (attemptStatus) {
        status = attemptStatus;
        raw = bodyFromError(message.errorMessage);
      }
    }
  }

  if (status === null) return null;
  return { status, detail: keptRefusalDetail(raw, { credentials }) };
};

/**
 * The seat-log clause. The status is always present; the detail only when the
 * keep-list kept one. `grep 'upstream refused'` finds every refusal, which is
 * the property the old `no wrapper-post (empty output)` line did not have.
 */
export const describeUpstreamRefusal = (refusal) => {
  if (!refusal || typeof refusal.status !== 'number') return null;
  return refusal.detail
    ? `upstream refused ${refusal.status}: ${refusal.detail}`
    : `upstream refused ${refusal.status}`;
};

/**
 * The credential values this spawn was handed, for the exact-match check in
 * `redactKnownCredentials`. `envNames` are the adapter's own provider keys; the
 * caller supplies them because only the adapter knows which key its route uses.
 */
export const spawnCredentials = (ctx = {}, envNames = []) => {
  const env = ctx.env || process.env || {};
  return [
    ctx.runtimeToken,
    ...envNames.map((name) => env[name]),
  ].filter((value) => typeof value === 'string' && value.length >= 8);
};
