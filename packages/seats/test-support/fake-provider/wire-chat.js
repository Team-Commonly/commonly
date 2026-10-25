/**
 * OpenAI chat completions (`POST /v1/chat/completions`). The text, refusal and
 * failure bodies are byte-for-byte what the provider sent before scripts
 * existed; other tracks' checks read them.
 */
import { textOf } from './turns.js';

export const format = 'openai-chat';
export const refusalDefault = 'error';

export const entries = (body) => (Array.isArray(body?.messages) ? body.messages : []).map((m) => {
  if (m?.role === 'tool') {
    return { role: 'tool', text: '', toolResults: [{ callId: m.tool_call_id || null, output: textOf(m.content), isError: false }] };
  }
  return {
    role: m?.role || 'user',
    text: textOf(m?.content),
    toolCalls: (m?.tool_calls || []).map((c) => ({ id: c.id, name: c.function?.name })),
  };
});

const STOP = { end: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'stop' };
const finishOf = (turn) => STOP[turn.stop] || turn.stop || (turn.toolCalls.length ? 'tool_calls' : 'stop');
const argsOf = (call) => (typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments));
const halves = (s) => (s.length < 2 ? [s] : [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))]);

const errorBody = (error) => ({ error: { message: error.message, type: error.type || 'server_error' } });
const REFUSAL_ERROR = { error: { message: 'The request was rejected by the content policy.', type: 'invalid_request_error', code: 'content_policy_violation' } };

export const respond = (turn, { reply, body, model, n, usage }) => {
  if (turn.error && !turn.error.inStream) {
    reply.json(turn.error.status, errorBody(turn.error), turn.error.headers);
    return [];
  }
  const inband = (turn.refuseAs || refusalDefault) === 'inband';
  if (turn.refuse !== null && !inband) { reply.json(400, REFUSAL_ERROR); return []; }

  const id = `chatcmpl-fake-${n}`;
  const created = Math.floor(Date.now() / 1000);
  const calls = turn.toolCalls.map((c, i) => ({ id: `call_fake_${n}_${i}`, name: c.name, arguments: argsOf(c) }));
  const usageBody = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output };
  const finish = finishOf(turn);
  const modelName = body.model || model;

  if (!body.stream) {
    const message = { role: 'assistant', content: turn.refuse !== null ? null : turn.text.join('') };
    if (turn.refuse !== null) message.refusal = turn.refuse;
    if (turn.thought) message.reasoning_content = turn.thought;
    if (calls.length) message.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
    if (turn.error) { reply.json(turn.error.status, errorBody(turn.error), turn.error.headers); return calls; }
    reply.json(200, { id, object: 'chat.completion', created, model: modelName, choices: [{ index: 0, message, finish_reason: finish }], usage: usageBody });
    return calls;
  }

  const sse = reply.sse();
  const chunk = (delta, finishReason = null, extra = {}) => sse.event(null, { id, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra });
  chunk({ role: 'assistant', content: '' });
  if (turn.thought) chunk({ reasoning_content: turn.thought });
  if (turn.refuse !== null) chunk({ refusal: turn.refuse });
  for (const text of turn.text) chunk({ content: text });
  calls.forEach((c, i) => {
    chunk({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] });
    for (const part of halves(c.arguments)) chunk({ tool_calls: [{ index: i, function: { arguments: part } }] });
  });
  if (turn.error) { sse.event(null, errorBody(turn.error)); sse.end(); return calls; }
  const includeUsage = !!body.stream_options?.include_usage;
  chunk({}, finish, includeUsage ? {} : { usage: usageBody });
  if (includeUsage) sse.event(null, { id, object: 'chat.completion.chunk', created, model: modelName, choices: [], usage: usageBody });
  sse.event(null, '[DONE]');
  sse.end();
  return calls;
};
