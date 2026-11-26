#!/usr/bin/env node
// .cjs, not .mjs: jest runs every .mjs under __tests__ as a suite.
//
// A scripted fake ACP agent for acp-client.test.mjs. It speaks newline-delimited
// JSON-RPC 2.0 on stdio, and each method the client calls picks a behaviour, so
// one process serves many cases. argv[2] (or ACP_FAKE_SCENARIO) sets a startup
// behaviour: `crash-on-request` exits as soon as any request arrives.

const scenario = process.argv[2] || process.env.ACP_FAKE_SCENARIO || 'default';
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const inbox = [];
const waiting = new Map(); // id of our request to the client -> resolve
let nextOwnId = 0;

const askClient = (method, params) => new Promise((resolve) => {
  const id = `agent-${nextOwnId++}`;
  waiting.set(id, resolve);
  send({ jsonrpc: '2.0', id, method, params });
});

const behaviours = {
  async echo(params) { return { echoed: params }; },
  async fail() {
    throw { code: -32002, message: 'Resource not found', data: { sessionId: 'sess_missing' } };
  },
  async 'stream-updates'(params) {
    for (let i = 0; i < 3; i++) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, seq: i } });
    }
    return { stopReason: 'end_turn' };
  },
  async 'ask-permission'() {
    const reply = await askClient('session/request_permission', { sessionId: 's1', options: [{ optionId: 'allow', kind: 'allow_once' }] });
    return { permissionReply: reply };
  },
  async 'ask-unknown'() {
    return { reply: await askClient('x/not_a_method', {}) };
  },
  async 'ask-failing'() {
    return { reply: await askClient('fs/read_text_file', { path: '/nope' }) };
  },
  async 'notify-unknown'() {
    send({ jsonrpc: '2.0', method: 'x/unknown_note', params: {} });
    return { ok: true };
  },
  async inbox() { return { inbox: inbox.slice() }; },
  async 'split-reply'(_params, id) {
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, result: { split: true, text: 'line\nbreak' } })}\n`;
    const half = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, half));
    await new Promise((r) => setTimeout(r, 30));
    process.stdout.write(line.slice(half));
    return undefined; // already answered
  },
  async 'two-in-one'(params, id) {
    const note = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, seq: 0 } });
    const reply = JSON.stringify({ jsonrpc: '2.0', id, result: { together: true } });
    process.stdout.write(`${note}\n${reply}\n`);
    return undefined;
  },
  async 'garbage-then-reply'() {
    process.stdout.write('Bearer sk-SECRET-0123456789abcdef is not json\n');
    process.stdout.write('\n');
    process.stdout.write('{"jsonrpc":"2.0","id":"sk-IDSECRET-nobody-asked","result":{}}\n');
    return { afterGarbage: true };
  },
  async 'crash-mid'() {
    process.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"partial":');
    setTimeout(() => process.exit(7), 10);
    return undefined;
  },
  async hang() { return undefined; },
  async 'big-reply'(params, id) {
    send({ jsonrpc: '2.0', id, result: { blob: 'x'.repeat(params.bytes) } });
    return undefined;
  },
};

const handle = async (msg) => {
  if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
    const resolve = waiting.get(msg.id);
    if (resolve) { waiting.delete(msg.id); resolve(msg.error ? { error: msg.error } : { result: msg.result }); }
    else inbox.push({ strayResponse: msg });
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(msg, 'id')) { inbox.push({ notification: msg.method, params: msg.params }); return; }
  if (scenario === 'crash-on-request') process.exit(9);
  const behaviour = behaviours[msg.method];
  if (!behaviour) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }); return; }
  if (msg.method === 'hang') return;
  try {
    const result = await behaviour(msg.params || {}, msg.id);
    if (result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (err) {
    send({ jsonrpc: '2.0', id: msg.id, error: err });
  }
};

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let nl;
  while ((nl = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
