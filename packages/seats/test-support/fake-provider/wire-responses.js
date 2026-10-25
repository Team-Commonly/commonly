/**
 * OpenAI Responses (`POST /v1/responses`), the wire codex speaks with
 * `wire_api = "responses"`. Event names and fields follow the official openai
 * SDK's `resources/responses` types. Every event carries `type` and a rising
 * `sequence_number`, and is also sent as the SSE `event:` name.
 */
import { textOf } from './turns.js';

export const format = 'openai-responses';
// A model refusal here is a `refusal` content part in a completed response.
export const refusalDefault = 'inband';

const TOOL_CALL_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const TOOL_OUTPUT_ITEMS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);

export const entries = (body) => {
  if (typeof body?.input === 'string') return [{ role: 'user', text: body.input, toolCalls: [] }];
  const out = [];
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (TOOL_OUTPUT_ITEMS.has(item?.type)) {
      const output = typeof item.output === 'string' ? item.output : textOf(item.output);
      out.push({ role: 'tool', text: '', toolResults: [{ callId: item.call_id || null, output, isError: false }] });
    } else if (TOOL_CALL_ITEMS.has(item?.type)) {
      const call = { id: item.call_id, name: item.name || item.type };
      const last = out[out.length - 1];
      if (last?.role === 'assistant') last.toolCalls.push(call);
      else out.push({ role: 'assistant', text: '', toolCalls: [call] });
    } else if (item?.role) {
      out.push({ role: item.role, text: textOf(item.content), toolCalls: [] });
    }
  }
  return out;
};

export const errorBody = (status, error = {}) => ({
  error: {
    message: error.message,
    type: error.type || (status >= 500 ? 'server_error' : 'invalid_request_error'),
    param: null,
    code: status === 429 ? 'rate_limit_exceeded' : status >= 500 ? 'server_error' : null,
  },
});
const REFUSAL_ERROR = { error: { message: 'The request was rejected by the content policy.', type: 'invalid_request_error', param: null, code: 'content_policy_violation' } };

const argsOf = (call) => (typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments));
const halves = (s) => (s.length < 2 ? [s] : [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))]);

/** The finished output items, in the order the stream announces them. */
const outputItems = (turn, n, calls) => {
  const items = [];
  if (turn.thought) {
    items.push({ type: 'reasoning', id: `rs_fake_${n}`, summary: [{ type: 'summary_text', text: turn.thought }] });
  }
  if (turn.refuse !== null || turn.text.length) {
    const part = turn.refuse !== null
      ? { type: 'refusal', refusal: turn.refuse }
      : { type: 'output_text', text: turn.text.join(''), annotations: [] };
    items.push({ type: 'message', id: `msg_fake_${n}`, role: 'assistant', status: 'completed', content: [part] });
  }
  for (const c of calls) {
    items.push({ type: 'function_call', id: c.itemId, call_id: c.id, name: c.name, arguments: c.arguments, status: 'completed' });
  }
  return items;
};

export const respond = (turn, { reply, body, model, n, usage }) => {
  if (turn.error && !turn.error.inStream) {
    reply.json(turn.error.status, errorBody(turn.error.status, turn.error), turn.error.headers);
    return [];
  }
  const inband = (turn.refuseAs || refusalDefault) === 'inband';
  if (turn.refuse !== null && !inband) { reply.json(400, REFUSAL_ERROR); return []; }

  const calls = turn.toolCalls.map((c, i) => ({ id: `call_fake_${n}_${i}`, itemId: `fc_fake_${n}_${i}`, name: c.name, arguments: argsOf(c) }));
  const items = outputItems(turn, n, calls);
  const incomplete = turn.stop === 'max_tokens';
  const usageBody = {
    input_tokens: usage.input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.input + usage.output,
  };
  const response = (status, output, extra = {}) => ({
    id: `resp_fake_${n}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status,
    error: null, incomplete_details: null, instructions: null, model: body.model || model,
    output, parallel_tool_calls: true, tool_choice: 'auto', tools: [], metadata: {}, usage: null, ...extra,
  });
  const finalStatus = incomplete ? 'incomplete' : 'completed';
  const finalExtra = { usage: usageBody, ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) };

  if (!body.stream) {
    if (turn.error) { reply.json(turn.error.status, errorBody(turn.error.status, turn.error)); return calls; }
    reply.json(200, response(finalStatus, items, finalExtra));
    return calls;
  }

  const sse = reply.sse();
  let seq = 0;
  const emit = (type, data) => sse.event(type, { type, sequence_number: seq++, ...data });
  emit('response.created', { response: response('in_progress', []) });
  emit('response.in_progress', { response: response('in_progress', []) });
  items.forEach((item, output_index) => {
    if (item.type === 'reasoning') {
      emit('response.output_item.added', { output_index, item: { ...item, summary: [] } });
      const base = { item_id: item.id, output_index, summary_index: 0 };
      emit('response.reasoning_summary_part.added', { ...base, part: { type: 'summary_text', text: '' } });
      emit('response.reasoning_summary_text.delta', { ...base, delta: turn.thought });
      emit('response.reasoning_summary_text.done', { ...base, text: turn.thought });
      emit('response.reasoning_summary_part.done', { ...base, part: { type: 'summary_text', text: turn.thought } });
    } else if (item.type === 'message') {
      const part = item.content[0];
      emit('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', content: [] } });
      const base = { item_id: item.id, output_index, content_index: 0 };
      if (part.type === 'refusal') {
        emit('response.content_part.added', { ...base, part: { type: 'refusal', refusal: '' } });
        emit('response.refusal.delta', { ...base, delta: part.refusal });
        emit('response.refusal.done', { ...base, refusal: part.refusal });
      } else {
        emit('response.content_part.added', { ...base, part: { type: 'output_text', text: '', annotations: [] } });
        for (const delta of turn.text) emit('response.output_text.delta', { ...base, delta, logprobs: [] });
        emit('response.output_text.done', { ...base, text: part.text, logprobs: [] });
      }
      emit('response.content_part.done', { ...base, part });
    } else {
      emit('response.output_item.added', { output_index, item: { ...item, arguments: '', status: 'in_progress' } });
      const base = { item_id: item.id, output_index };
      for (const delta of halves(item.arguments)) emit('response.function_call_arguments.delta', { ...base, delta });
      emit('response.function_call_arguments.done', { ...base, arguments: item.arguments, name: item.name });
    }
    emit('response.output_item.done', { output_index, item });
  });
  if (turn.error) {
    emit('response.failed', {
      response: response('failed', items, { error: { code: 'server_error', message: turn.error.message } }),
    });
  } else {
    emit(incomplete ? 'response.incomplete' : 'response.completed', { response: response(finalStatus, items, finalExtra) });
  }
  sse.end();
  return calls;
};
