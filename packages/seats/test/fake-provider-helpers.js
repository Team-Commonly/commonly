/**
 * Client-side helpers for the fake-provider tests: an SSE reader, a raw HTTP
 * probe that can tell a finished, a silent and a closed response apart, and one
 * reader per wire format that folds a reply back into {text, thought, tools, stop}.
 */
import { request } from 'node:http';

export const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export const parseSSE = (text) => text.split('\n\n').filter((f) => f.trim()).map((frame) => {
  const event = /^event: (.*)$/m.exec(frame)?.[1] ?? null;
  const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
  let parsed = data;
  try { parsed = JSON.parse(data); } catch { /* [DONE] and friends stay strings */ }
  return { event, data: parsed };
});

/**
 * POST and watch the socket. `how` is 'end' (a complete response), 'closed'
 * (the server destroyed the socket) or 'silent' (nothing more within waitMs).
 */
export const probe = (url, body, { waitMs = 200, headers = {} } = {}) => new Promise((resolve) => {
  const payload = JSON.stringify(body);
  let text = '';
  let status = null;
  let settled = false;
  const done = (how) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    req.destroy();
    resolve({ status, text, how });
  };
  const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, (res) => {
    status = res.statusCode;
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => done('end'));
    res.on('aborted', () => done('closed'));
    res.on('error', () => done('closed'));
    res.on('close', () => { if (!res.complete) done('closed'); });
  });
  req.on('error', () => done('closed'));
  const timer = setTimeout(() => done('silent'), waitMs);
  req.end(payload);
});

const joinArgs = (s) => { try { return JSON.parse(s); } catch { return s; } };

/** Per-format request builders and readers, so one scenario table drives all three. */
export const WIRES = {
  anthropic: {
    path: (fake) => `${fake.anthropicBaseURL}/v1/messages`,
    body: (prompt, stream) => ({ model: 'm', max_tokens: 100, stream, messages: [{ role: 'user', content: prompt }] }),
    headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    readJson: (j) => ({
      text: j.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      thought: j.content.find((b) => b.type === 'thinking')?.thinking ?? null,
      tools: j.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: b.input })),
      stop: j.stop_reason,
      refusal: j.stop_details?.explanation ?? null,
    }),
    readStream: (events) => {
      const blocks = [];
      let stop = null;
      let refusal = null;
      for (const { data } of events) {
        if (data.type === 'content_block_start') blocks[data.index] = { ...data.content_block, buf: '' };
        if (data.type === 'content_block_delta') {
          const b = blocks[data.index];
          if (data.delta.type === 'text_delta') b.text += data.delta.text;
          if (data.delta.type === 'thinking_delta') b.thinking += data.delta.thinking;
          if (data.delta.type === 'input_json_delta') b.buf += data.delta.partial_json;
        }
        if (data.type === 'message_delta') { stop = data.delta.stop_reason; refusal = data.delta.stop_details?.explanation ?? null; }
      }
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        thought: blocks.find((b) => b.type === 'thinking')?.thinking ?? null,
        tools: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: joinArgs(b.buf) })),
        stop,
        refusal,
      };
    },
  },
  responses: {
    path: (fake) => `${fake.baseURL}/responses`,
    body: (prompt, stream) => ({ model: 'm', stream, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }] }),
    headers: { authorization: 'Bearer k' },
    readJson: (j) => {
      const msg = j.output.find((i) => i.type === 'message');
      return {
        text: msg?.content.filter((p) => p.type === 'output_text').map((p) => p.text).join('') ?? '',
        thought: j.output.find((i) => i.type === 'reasoning')?.summary[0]?.text ?? null,
        tools: j.output.filter((i) => i.type === 'function_call').map((i) => ({ id: i.call_id, name: i.name, arguments: joinArgs(i.arguments) })),
        stop: j.status,
        refusal: msg?.content.find((p) => p.type === 'refusal')?.refusal ?? null,
      };
    },
    readStream: (events) => {
      let text = '';
      let thought = null;
      let refusal = null;
      const calls = new Map();
      let stop = null;
      for (const { data } of events) {
        if (data.type === 'response.output_text.delta') text += data.delta;
        if (data.type === 'response.reasoning_summary_text.delta') thought = (thought || '') + data.delta;
        if (data.type === 'response.refusal.delta') refusal = (refusal || '') + data.delta;
        if (data.type === 'response.output_item.added' && data.item.type === 'function_call') calls.set(data.item.id, { id: data.item.call_id, name: data.item.name, buf: '' });
        if (data.type === 'response.function_call_arguments.delta') calls.get(data.item_id).buf += data.delta;
        if (/^response\.(completed|incomplete|failed)$/.test(data.type)) stop = data.response.status;
      }
      return { text, thought, refusal, stop, tools: [...calls.values()].map((c) => ({ id: c.id, name: c.name, arguments: joinArgs(c.buf) })) };
    },
  },
  chat: {
    path: (fake) => `${fake.baseURL}/chat/completions`,
    body: (prompt, stream) => ({ model: 'm', stream, messages: [{ role: 'user', content: prompt }] }),
    headers: { authorization: 'Bearer k' },
    readJson: (j) => {
      const m = j.choices[0].message;
      return {
        text: m.content || '',
        thought: m.reasoning_content ?? null,
        tools: (m.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, arguments: joinArgs(c.function.arguments) })),
        stop: j.choices[0].finish_reason,
        refusal: m.refusal ?? null,
      };
    },
    readStream: (events) => {
      let text = '';
      let thought = null;
      let refusal = null;
      let stop = null;
      const calls = [];
      for (const { data } of events) {
        const choice = data?.choices?.[0];
        if (!choice) continue;
        const d = choice.delta;
        if (d.content) text += d.content;
        if (d.reasoning_content) thought = (thought || '') + d.reasoning_content;
        if (d.refusal) refusal = (refusal || '') + d.refusal;
        for (const tc of d.tool_calls || []) {
          calls[tc.index] ||= { id: tc.id, name: tc.function.name, buf: '' };
          calls[tc.index].buf += tc.function.arguments || '';
        }
        if (choice.finish_reason) stop = choice.finish_reason;
      }
      return { text, thought, refusal, stop, tools: calls.map((c) => ({ id: c.id, name: c.name, arguments: joinArgs(c.buf) })) };
    },
  },
};

/** Run one scripted turn on one wire, streamed or not, and read it back. */
export const ask = async (fake, wire, { prompt = 'go', stream = false } = {}) => {
  const w = WIRES[wire];
  const res = await post(w.path(fake), w.body(prompt, stream), w.headers);
  const raw = await res.text();
  if (res.status !== 200) return { status: res.status, error: JSON.parse(raw), headers: res.headers };
  const events = stream ? parseSSE(raw) : null;
  return { status: 200, events, headers: res.headers, ...(stream ? w.readStream(events) : w.readJson(JSON.parse(raw))) };
};
