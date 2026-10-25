/**
 * Anthropic Messages (`POST /v1/messages`, `POST /v1/messages/count_tokens`).
 * Shapes follow the official TypeScript SDK's types (`resources/messages`,
 * `resources/shared`): the stream is message_start, ping, one
 * content_block_start/delta…/stop per block, message_delta, message_stop.
 */
import { textOf } from './turns.js';

export const format = 'anthropic';
// A model refusal on this API is a 200 with stop_reason "refusal", not an error.
export const refusalDefault = 'inband';

export const entries = (body) => (Array.isArray(body?.messages) ? body.messages : []).map((m) => {
  const blocks = Array.isArray(m?.content) ? m.content : [];
  const results = blocks.filter((b) => b?.type === 'tool_result');
  if (m?.role === 'user' && results.length) {
    return {
      role: 'tool',
      text: '',
      toolResults: results.map((b) => ({ callId: b.tool_use_id || null, output: textOf(b.content), isError: !!b.is_error })),
    };
  }
  return {
    role: m?.role || 'user',
    text: typeof m?.content === 'string' ? m.content : textOf(blocks.filter((b) => b?.type === 'text')),
    toolCalls: blocks.filter((b) => b?.type === 'tool_use').map((b) => ({ id: b.id, name: b.name })),
  };
});

const ERROR_TYPES = {
  400: 'invalid_request_error', 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error',
  404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error',
  504: 'timeout_error', 529: 'overloaded_error',
};
const ERROR_MESSAGES = { 529: 'Overloaded', 429: 'Number of request tokens has exceeded your rate limit.' };

export const errorBody = (status, error = {}, n = 0) => ({
  type: 'error',
  error: {
    type: error.type || ERROR_TYPES[status] || (status >= 500 ? 'api_error' : 'invalid_request_error'),
    message: error.message && error.message !== 'fake provider failure' ? error.message : ERROR_MESSAGES[status] || 'fake provider failure',
  },
  request_id: `req_fake_${n}`,
});

const REFUSAL_ERROR = { type: 'invalid_request_error', message: 'Output blocked by content filtering policy' };

const STOP = { end: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal' };
const stopOf = (turn) => (turn.refuse !== null ? 'refusal' : STOP[turn.stop] || turn.stop || (turn.toolCalls.length ? 'tool_use' : 'end_turn'));
const inputOf = (call) => {
  if (typeof call.arguments !== 'string') return call.arguments;
  try { return JSON.parse(call.arguments); } catch { return {}; }
};
const halves = (s) => (s.length < 2 ? [s] : [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))]);

export const countTokens = (reply, usage) => reply.json(200, { input_tokens: usage.input });

export const respond = (turn, { reply, body, model, n, usage }) => {
  const requestId = { 'request-id': `req_fake_${n}` };
  if (turn.error && !turn.error.inStream) {
    reply.json(turn.error.status, errorBody(turn.error.status, turn.error, n), { ...requestId, ...turn.error.headers });
    return [];
  }
  const inband = (turn.refuseAs || refusalDefault) === 'inband';
  if (turn.refuse !== null && !inband) {
    reply.json(400, errorBody(400, REFUSAL_ERROR, n), requestId);
    return [];
  }

  const calls = turn.toolCalls.map((c, i) => ({ id: `toolu_fake_${n}_${i}`, name: c.name, input: inputOf(c) }));
  const content = [];
  if (turn.thought) content.push({ type: 'thinking', thinking: turn.thought, signature: `fake-signature-${n}` });
  if (turn.text.length) content.push({ type: 'text', text: turn.text.join('') });
  for (const c of calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
  const stopReason = stopOf(turn);
  const stopDetails = turn.refuse !== null ? { type: 'refusal', category: null, explanation: turn.refuse } : null;
  const fullUsage = { input_tokens: usage.input, output_tokens: usage.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = (blocks, stop, u) => ({
    id: `msg_fake_${n}`, type: 'message', role: 'assistant', model: body.model || model,
    content: blocks, stop_reason: stop, stop_sequence: null, stop_details: stop ? stopDetails : null, usage: u,
  });

  if (!body.stream) {
    if (turn.error) { reply.json(turn.error.status, errorBody(turn.error.status, turn.error, n), requestId); return calls; }
    reply.json(200, message(content, stopReason, fullUsage), requestId);
    return calls;
  }

  const sse = reply.sse(requestId);
  sse.event('message_start', { type: 'message_start', message: message([], null, { ...fullUsage, output_tokens: 1 }) });
  sse.event('ping', { type: 'ping' });
  let index = 0;
  const block = (start, deltas) => {
    sse.event('content_block_start', { type: 'content_block_start', index, content_block: start });
    for (const delta of deltas) sse.event('content_block_delta', { type: 'content_block_delta', index, delta });
    sse.event('content_block_stop', { type: 'content_block_stop', index });
    index += 1;
  };
  if (turn.thought) {
    block({ type: 'thinking', thinking: '', signature: '' }, [
      { type: 'thinking_delta', thinking: turn.thought },
      { type: 'signature_delta', signature: `fake-signature-${n}` },
    ]);
  }
  if (turn.text.length) block({ type: 'text', text: '' }, turn.text.map((text) => ({ type: 'text_delta', text })));
  for (const c of calls) {
    // The real API streams tool input as JSON fragments; the client must join them.
    block({ type: 'tool_use', id: c.id, name: c.name, input: {} },
      halves(JSON.stringify(c.input)).map((partial_json) => ({ type: 'input_json_delta', partial_json })));
  }
  if (turn.error) {
    sse.event('error', errorBody(turn.error.status, turn.error, n));
    sse.end();
    return calls;
  }
  sse.event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails },
    usage: { output_tokens: usage.output },
  });
  sse.event('message_stop', { type: 'message_stop' });
  sse.end();
  return calls;
};
