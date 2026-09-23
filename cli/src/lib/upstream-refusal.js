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
 * Scope: this reader was wired into the pi adapter only. TASK-103 extended it
 * to codex and claude, which are NOT silent the way pi was: the claude adapter
 * rejects on a non-zero exit and deliberately reports stdout with it, because a
 * `-p` run writes quota conditions there; the codex adapter rejects on
 * `turnFailedMessage` even at exit 0. Their gap was the opposite one — the text
 * they raised was the raw tail, unscrubbed by the rules above, and carried no
 * HTTP status for the run loop to classify on. `scrubAdapterFailure` below is
 * the shared reader they now both go through, so the two rules cannot drift
 * apart between three adapters.
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
 * Does this text parse as a JSON object? The gate for the whole-tail fallback
 * below — deliberately NOT `kept === null`, which is true for five different
 * reasons (Vera 71350).
 */
const isJsonObject = (raw) => {
  try {
    const parsed = JSON.parse(String(raw ?? ''));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
};

/**
 * A 3-digit number is read as a status only when the tail NAMES it as one:
 * `status 429`, `HTTP 429`, `code: "429"` — or when it opens the tail or a ` | `
 * segment followed by a colon, which is the shape claude's `stderr | stdout`
 * join produces for a body that leads with its status.
 *
 * A bare `\b(\d{3})\b` scan is not enough, and the false positives are not
 * hypothetical: `500 tokens`, `"max_tokens": 500` and `retry in 500 seconds`
 * all read as 500, and `classifySpawnFailure` tests the status FIELD before the
 * message — so a count misread as a status stands the fleet down on a refusal
 * that never happened, which is worse than no status at all (Vera 71352).
 */
const STATUS_NAMED = /\b(?:status(?:_?code)?|code|http)\b\W{0,4}(\d{3})(?!\d)/gi;
const STATUS_COLON = /(?:^|\|\s*)(\d{3})(?!\d)\s*:/g;

/** The first 4xx/5xx one of those shapes names, or null. */
const scanStatuses = (text, pattern) => {
  for (const match of String(text ?? '').matchAll(pattern)) {
    const value = Number(match[1]);
    if (value >= 400 && value <= 599) return value;
  }
  return null;
};

/**
 * Find the status AND the body boundary, because they are the same question.
 *
 * Anchoring the status to a ` | ` segment start is not enough on its own: the
 * body has to be taken from just past that status too, or a mid-tail read
 * isolates the status and then hands the WHOLE joined tail to the body rules,
 * which no longer look like a JSON body and so fall through to "keep it all".
 * That is the difference between dropping a credential-echoing body and shipping
 * the part of it that exact-match cannot see.
 *
 * `STATUS_COLON` is the only shape that moves the boundary, because it is the
 * same shape as the anchored prefix (`429: {body}`), just found at a segment
 * boundary — claude's `stderr | stdout` join. A status that appears inside a
 * body (`{"error":{"code":"429"}}`) or as prose (`HTTP 503`) names the status
 * but marks no boundary, so the whole text stays the body.
 */
const readStatusAndBody = (text) => {
  const raw = String(text ?? '');
  const prefixed = statusFromError(raw);
  if (prefixed !== null) return { status: prefixed, body: bodyFromError(raw) };
  for (const match of raw.matchAll(STATUS_COLON)) {
    const value = Number(match[1]);
    if (value >= 400 && value <= 599) {
      return { status: value, body: raw.slice(match.index + match[0].length).replace(/^\s*:?\s*/, '') };
    }
  }
  return { status: scanStatuses(raw, STATUS_NAMED), body: raw };
};

/**
 * The shared reader for an adapter's own failure tail (TASK-103).
 *
 * The two rules above are about a body an adapter captured, and they apply here
 * too — but the tail is a different shape from pi's refusal, and the difference
 * decides how each rule lands:
 *
 *  - The tail is often NOT JSON. Claude's `-p` mode writes its terminal
 *    condition as prose (`Claude usage limit reached. Your limit will reset at
 *    11:40pm.`), and that line is the whole diagnostic value of reporting
 *    stdout at all — 361 consecutive failures on 2026-08-03 carried no reason
 *    because of it. So the keep-list applies only when the tail parses as a
 *    body; when it does not, the text is KEPT as a whole shape and the
 *    exact-match rule is what protects it (`redactKnownCredentials`, which
 *    substitutes rather than drops, precisely because a whole-shape text has no
 *    second field to fall back to).
 *
 *  - A body that IS JSON is reduced to one named field, and a body whose field
 *    echoed a value this spawn was handed is DROPPED WHOLE — the same trade rule
 *    2 makes everywhere. The fallback to the whole tail is gated on the SHAPE
 *    (not a JSON object), never on "the keep-list returned null": that null has
 *    four other causes, and one of them is the credential echo this line exists
 *    to drop. Gating on `kept === null` would emit the whole body for that case,
 *    which is precisely what rule 2 forbids — and exact-match cannot see a
 *    transformed shape (limit (a) in the header), so a key that arrived
 *    base64'd or percent-encoded would ship (Vera 71350/71351).
 *
 * Returns `{ status, detail }`: `status` is the 4xx/5xx the tail named, or null.
 * The caller decides where the status goes; `classifySpawnFailure` reads it off
 * `error.status` or out of the message text, so both a leading `429: …` prefix
 * and an attached field classify the same way. `detail` is `''` when nothing of
 * the body may be shown — the status is then the whole diagnostic.
 */
export const scrubAdapterFailure = (text, { credentials = [], limit = MAX_REFUSAL_DETAIL } = {}) => {
  const raw = String(text ?? '').trim();
  const { status, body } = readStatusAndBody(raw);
  const kept = keptRefusalDetail(body, { credentials });
  const detail = kept ?? (isJsonObject(body) ? '' : redactKnownCredentials(body, credentials));
  return { status, detail: detail.slice(0, limit) };
};

/**
 * The Error an adapter raises, built from its own failure tail.
 *
 * `status` is attached as a field, not only written into the text: the run
 * loop's classifier tests `error.status === 429` before it looks at the
 * message, and a refusal that is only readable by regex is one wording away
 * from the misclassification that cost an hour on 2026-08-18 (see
 * spawn-retry.js). The message still names the status so a human log says the
 * same thing as the classifier's decision.
 */
export const adapterFailure = (label, text, { credentials = [], exitCode = null, limit } = {}) => {
  const { status, detail } = scrubAdapterFailure(text, { credentials, limit });
  const code = exitCode === null ? '' : ` exited with code ${exitCode}`;
  const named = status === null ? '' : ` (upstream ${status})`;
  const error = new Error(`${label}${code}${named}${detail ? `: ${detail}` : ''}`);
  if (status !== null) error.status = status;
  return error;
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
