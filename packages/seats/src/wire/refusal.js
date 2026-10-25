/**
 * In-band refusal detection over provider response bodies.
 *
 * A provider can refuse inside a 200: Anthropic Messages ends the message with
 * `stop_reason: "refusal"`, OpenAI Responses returns a `refusal` content part,
 * and chat completions sets `message.refusal` (or a refusal finish_reason). A
 * CLI that does not surface that can exit 0 with an empty reply. codex 0.162.1
 * under `codex exec --json` was seen to do this against the fake provider's
 * Responses refusal, and the run then looks like an empty success.
 *
 * This module only reads bodies, and on the live path it is handed none today.
 * The codex and claude adapters let the CLI reach its provider itself, with
 * the provider settings taken from the CLI's own config and env. The run
 * sandbox's egress proxy (valet/egress-proxy.js, in progress) relays CONNECT
 * tunnels, which carry TLS, plus a raw byte relay to a loopback provider; it
 * parses neither. The one body-forwarding relay in the repo,
 * cli/src/lib/provider-proxy.js, serves chat completions for the
 * OpenAI-compatible adapters and inspects nothing.
 *
 * Proposed signal (not built): a loopback provider relay the supervisor owns
 * for each run. The adapter points its CLI at the relay instead of the
 * provider (a `-c model_providers.*` base_url override for codex,
 * ANTHROPIC_BASE_URL for claude). The relay forwards each request to the real
 * provider over TLS and tees each response body into createRefusalTap(). After
 * a clean exit the supervisor passes the run's refusals and the adapter's
 * result to refusalDropped() and settles the failure it returns. Open points:
 * a CLI signed in by OAuth sends its own auth header, which the relay must
 * forward rather than replace; and a CLI that ignores a base-URL override
 * cannot be covered this way. Until the relay exists, refusal_dropped cannot
 * fire on a live run.
 *
 * The functions here are pure apart from the tap's own buffer. Nothing is
 * logged, and a detection carries the model's refusal text and the format.
 */
import { StringDecoder } from 'node:string_decoder';
import { RunFailure } from '../failures.js';

export const REFUSAL_FORMATS = Object.freeze(['anthropic', 'openai-responses', 'openai-chat']);

// Chat's own refusal finish reasons. `content_filter` is the provider's filter
// stopping the output, which a CLI that drops it presents the same way.
const CHAT_REFUSAL_FINISH = new Set(['refusal', 'content_filter']);
// The cap on a buffered non-stream JSON body. Past it the tap stops reading.
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

const isObject = (value) => !!value && typeof value === 'object';
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

/** A refusal content part or block → its text ('' when it carries none). */
const partText = (part) => {
  if (nonEmpty(part?.refusal)) return part.refusal;
  if (nonEmpty(part?.text)) return part.text;
  return '';
};

const refusalPartIn = (content) => (Array.isArray(content) ? content.find((p) => p?.type === 'refusal') : undefined);

// Anthropic: a refusal is a stop_reason (or stop_details.type) of "refusal",
// on a whole message or on the stream's message_delta. A content block of type
// "refusal" is read too, should the API add one.
const anthropicSignals = (event) => {
  const out = [];
  const stopOf = (holder, via) => {
    if (!isObject(holder)) return;
    if (holder.stop_reason === 'refusal' || holder.stop_details?.type === 'refusal') {
      out.push({ signal: via, text: nonEmpty(holder.stop_details?.explanation) ? holder.stop_details.explanation : null });
    }
  };
  if (event.type === 'message') {
    stopOf(event, 'stop_reason');
    const part = refusalPartIn(event.content);
    if (part) out.push({ signal: 'refusal_block', text: partText(part) || null });
  } else if (event.type === 'message_start') {
    stopOf(event.message, 'stop_reason');
  } else if (event.type === 'message_delta') {
    stopOf(event.delta, 'stop_reason');
  } else if (event.type === 'content_block_start' && event.content_block?.type === 'refusal') {
    out.push({ signal: 'refusal_block', text: partText(event.content_block) || null });
  }
  return out;
};

// OpenAI Responses: a `refusal` content part, streamed as
// response.refusal.delta/done, announced by content_part.added/done, and kept in
// the finished output item and the final Response object.
const responsesSignals = (event) => {
  const out = [];
  const fromOutput = (output) => {
    for (const item of Array.isArray(output) ? output : []) {
      const part = refusalPartIn(item?.content);
      if (part) out.push({ signal: 'refusal_part', text: partText(part) || null });
    }
  };
  const fromResponse = (response) => {
    if (!isObject(response)) return;
    fromOutput(response.output);
    if (response.incomplete_details?.reason === 'content_filter') out.push({ signal: 'content_filter', text: null });
  };
  switch (event.type) {
    case 'response.refusal.delta':
      out.push({ signal: 'refusal_part', delta: typeof event.delta === 'string' ? event.delta : '' });
      break;
    case 'response.refusal.done':
      out.push({ signal: 'refusal_part', text: nonEmpty(event.refusal) ? event.refusal : null });
      break;
    case 'response.content_part.added':
    case 'response.content_part.done':
      if (event.part?.type === 'refusal') out.push({ signal: 'refusal_part', text: partText(event.part) || null });
      break;
    case 'response.output_item.added':
    case 'response.output_item.done':
      fromOutput([event.item]);
      break;
    case 'response.created':
    case 'response.in_progress':
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      fromResponse(event.response);
      break;
    default:
      if (event.object === 'response') fromResponse(event);
  }
  return out;
};

// Chat completions: message.refusal on a whole completion, delta.refusal on a
// chunk, and a refusal finish_reason on either.
const chatSignals = (event) => {
  const out = [];
  for (const choice of Array.isArray(event.choices) ? event.choices : []) {
    if (event.object === 'chat.completion.chunk') {
      if (nonEmpty(choice?.delta?.refusal)) out.push({ signal: 'message.refusal', delta: choice.delta.refusal });
    } else if (nonEmpty(choice?.message?.refusal)) {
      out.push({ signal: 'message.refusal', text: choice.message.refusal });
    }
    if (CHAT_REFUSAL_FINISH.has(choice?.finish_reason)) out.push({ signal: 'finish_reason', text: null });
  }
  return out;
};

/** The wire format a parsed event or body belongs to, from its shape alone. */
export const formatOf = (event) => {
  if (!isObject(event)) return null;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type.startsWith('response.') || event.object === 'response') return 'openai-responses';
  if (event.object === 'chat.completion' || event.object === 'chat.completion.chunk') return 'openai-chat';
  if (type === 'message' || type.startsWith('message_') || type.startsWith('content_block_')) return 'anthropic';
  return null;
};

const SIGNALS = { anthropic: anthropicSignals, 'openai-responses': responsesSignals, 'openai-chat': chatSignals };

/**
 * One parsed event (a stream frame's data, or a whole JSON body) → the refusal
 * signals it carries: [{ format, signal, text?, delta? }]. Empty when none.
 */
export const refusalSignalsOf = (event) => {
  const format = formatOf(event);
  if (!format) return [];
  return SIGNALS[format](event).map((s) => ({ format, ...s }));
};

/**
 * A detector for ONE response: push its events in order, then read
 * `refusal`: null, or { format, signal, text } where text is the refusal the
 * provider sent ('' when it sent only a stop reason).
 */
export const createRefusalDetector = () => {
  let first = null;
  let finalText = null;
  let deltas = '';
  return {
    push(event) {
      for (const s of refusalSignalsOf(event)) {
        if (!first) first = { format: s.format, signal: s.signal };
        if (typeof s.delta === 'string') deltas += s.delta;
        if (nonEmpty(s.text) && finalText === null) finalText = s.text;
      }
    },
    get refusal() {
      return first ? { ...first, text: finalText ?? deltas } : null;
    },
  };
};

/** Pure: the refusal in one response's captured events, or null. */
export const findRefusal = (events) => {
  const detector = createRefusalDetector();
  for (const event of Array.isArray(events) ? events : []) detector.push(event);
  return detector.refusal;
};

const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

/**
 * A byte tap for ONE response body, SSE or JSON, written in chunks of any size.
 * Chunk boundaries may fall anywhere, including inside a UTF-8 sequence.
 * `end()` flushes; `refusal` is readable at any time. A JSON body past
 * MAX_JSON_BYTES stops being read and sets `overflowed`.
 */
export const createRefusalTap = ({ contentType } = {}) => {
  const detector = createRefusalDetector();
  const decoder = new StringDecoder('utf8');
  let mode = contentType ? (/event-stream/i.test(contentType) ? 'sse' : 'json') : null;
  let buffer = '';
  let bytes = 0;
  let overflowed = false;
  let ended = false;

  const frame = (block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    const event = parseJson(data);
    if (event !== undefined) detector.push(event);
  };
  const drainFrames = () => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) return;
      frame(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  };
  const take = (text) => {
    if (mode === null) {
      if (!text.trim()) return; // leading whitespace decides nothing
      mode = text.trimStart().startsWith('{') ? 'json' : 'sse';
    }
    if (mode === 'sse') { buffer += text; drainFrames(); return; }
    if (overflowed) return;
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_JSON_BYTES) { overflowed = true; buffer = ''; return; }
    buffer += text;
  };

  return {
    write(chunk) {
      if (ended) return;
      take(typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk)));
    },
    end(chunk) {
      if (ended) return;
      if (chunk !== undefined) this.write(chunk);
      ended = true;
      take(decoder.end());
      if (mode === 'sse') { if (buffer.trim()) frame(buffer); } else if (mode === 'json' && !overflowed) {
        const body = parseJson(buffer);
        if (body !== undefined) detector.push(body);
      }
      buffer = '';
    },
    get refusal() { return detector.refusal; },
    get overflowed() { return overflowed; },
  };
};

/**
 * The settle rule for a run whose CLI exited cleanly. `refusals` are what the
 * run's responses carried (null entries are ignored); `result` is the adapter's
 * resolved SpawnResult. A refusal counts as surfaced only when the result's text
 * contains the refusal's text; a refusal that sent no text is never surfaced by
 * an exit-0 reply. Returns RunFailure('refusal_dropped') or null.
 */
export const refusalDropped = ({ refusals = [], result } = {}) => {
  const seen = (Array.isArray(refusals) ? refusals : [refusals]).filter(Boolean);
  if (!seen.length) return null;
  const reply = typeof result?.text === 'string' ? result.text : '';
  const dropped = seen.find((r) => !(nonEmpty(r.text?.trim()) && reply.includes(r.text.trim())));
  if (!dropped) return null;
  const failure = new RunFailure('refusal_dropped',
    `the provider refused in-band (${dropped.format} ${dropped.signal}, ${String(dropped.text || '').length} chars) and the CLI exited 0 without surfacing it`);
  failure.refusal = { format: dropped.format, signal: dropped.signal, text: dropped.text || '' };
  return failure;
};
