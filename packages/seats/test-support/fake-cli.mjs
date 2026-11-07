#!/usr/bin/env node
/**
 * A tiny agent CLI for the compatibility matrix: a real child process that
 * reads a prompt on stdin, makes one OpenAI-compatible call, and writes JSONL.
 *
 *   fake-cli --version                 prints "fake-cli <version>"
 *   fake-cli run [--resume ID]         one turn; the prompt arrives on stdin
 *
 * Provider settings arrive in env (FAKE_CLI_BASE_URL, FAKE_CLI_MODEL,
 * FAKE_CLI_API_KEY), or the key as `--api-key K` when an adapter misbehaves.
 * FAKE_CLI_FAULT selects a child-side defect so the matrix can prove it
 * notices one: echo-key, extra-text, new-session, error-echo-key, double-call,
 * retry-5xx-forever.
 *
 * Output lines: {type:'message', text} then {type:'result', ok:true, text,
 * session_id} or {type:'result', ok:false, status, error}.
 */
import { randomUUID } from 'node:crypto';

const VERSION = process.env.FAKE_CLI_VERSION || '1.0.0';
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1] ?? null;
};
const write = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (argv[0] === '--version') {
  process.stdout.write(`fake-cli ${VERSION}\n`);
  process.exit(0);
}
if (argv[0] !== 'run') {
  process.stderr.write('usage: fake-cli run [--resume ID]\n');
  process.exit(2);
}

const fault = process.env.FAKE_CLI_FAULT || '';
const key = flag('--api-key') || process.env.FAKE_CLI_API_KEY || '';
const sessionId = (fault !== 'new-session' && flag('--resume')) || `fake-${randomUUID()}`;

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const ask = () => fetch(`${process.env.FAKE_CLI_BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: process.env.FAKE_CLI_MODEL, messages: [{ role: 'user', content: prompt }] }),
}).catch((error) => ({ ok: false, status: 0, text: async () => String(error?.message || error) }));

// double-call: a second request per turn, the way a CLI that also titles its
// session behaves. retry-5xx-forever: never gives up on a server error.
if (fault === 'double-call') await (await ask()).text();
let response = await ask();
while (fault === 'retry-5xx-forever' && response.status >= 500) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  response = await ask();
}

if (!response.ok) {
  const body = await response.text();
  const error = fault === 'error-echo-key' ? `provider rejected key ${key}: ${body}` : body;
  write({ type: 'result', ok: false, status: response.status, error });
  process.exit(1);
}

const answer = (await response.json())?.choices?.[0]?.message?.content ?? '';
let text = answer;
if (fault === 'echo-key') text = `${answer} (key ${key})`;
if (fault === 'extra-text') text = `${answer}\n\nLet me know if you need anything else.`;
write({ type: 'message', text });
write({ type: 'result', ok: true, text, session_id: sessionId });
