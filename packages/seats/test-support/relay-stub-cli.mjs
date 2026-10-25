#!/usr/bin/env node
/**
 * A stand-in for a model-calling CLI, for the provider relay tests. It makes
 * one streamed model request to the base URL it is handed, with the headers it
 * is handed, and prints the reply. Like codex 0.162.1 against an in-band
 * Responses refusal, it drops a refusal and exits 0 with an empty reply unless
 * STUB_SURFACE=1.
 *
 *   STUB_BASE_URL  base URL to call (the relay's, or the provider's directly)
 *   STUB_WIRE      responses | anthropic | chat        (default responses)
 *   STUB_HEADERS   JSON object of request headers, auth included
 *   STUB_PROMPT    the prompt text sent in the request body
 *   STUB_SURFACE   '1' prints the refusal text instead of dropping it
 *
 * It writes nothing but its reply on stdout.
 */
const base = String(process.env.STUB_BASE_URL || '').replace(/\/+$/, '');
const wire = process.env.STUB_WIRE || 'responses';
const headers = JSON.parse(process.env.STUB_HEADERS || '{}');
const prompt = process.env.STUB_PROMPT || 'hello';

const REQUESTS = {
  responses: () => [`${base}/responses`, { model: 'm', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }] }],
  anthropic: () => [`${base}/v1/messages?beta=true`, { model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: prompt }] }],
  chat: () => [`${base}/chat/completions`, { model: 'm', stream: true, messages: [{ role: 'user', content: prompt }] }],
};

const frames = (text) => text.split(/\r?\n\r?\n/).map((frame) => frame.split(/\r?\n/)
  .filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
  .filter((data) => data && data !== '[DONE]')
  .flatMap((data) => { try { return [JSON.parse(data)]; } catch { return []; } });

const read = (events) => {
  let text = '';
  let refusal = '';
  for (const e of events) {
    if (e.type === 'response.output_text.delta' || e.delta?.type === 'text_delta') text += e.delta?.text ?? e.delta ?? '';
    if (e.type === 'response.refusal.delta') refusal += e.delta;
    if (e.type === 'message_delta' && e.delta?.stop_details?.explanation) refusal += e.delta.stop_details.explanation;
    for (const choice of e.choices || []) {
      if (choice.delta?.content) text += choice.delta.content;
      if (choice.delta?.refusal) refusal += choice.delta.refusal;
    }
  }
  return { text, refusal };
};

const [url, body] = REQUESTS[wire]();
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
if (!response.ok) {
  process.stderr.write(`model request failed: HTTP ${response.status}\n`);
  process.exit(1);
}
const { text, refusal } = read(frames(await response.text()));
process.stdout.write(process.env.STUB_SURFACE === '1' && refusal ? refusal : text);
