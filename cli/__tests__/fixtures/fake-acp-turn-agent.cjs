#!/usr/bin/env node
// .cjs, not .mjs: jest runs every .mjs under __tests__ as a suite.
//
// A scripted fake ACP agent for acp-adapter.test.mjs. argv[2] is a JSON file
// holding the scenario; argv[3] is a file this agent appends one JSON line to
// for everything it sees (its argv, cwd and environment names at start, then
// each inbound message), so a test can assert what the adapter sent.
//
// Scenario fields:
//   protocolVersion   the version initialize answers with (default 1)
//   authMethods       initialize's authMethods (default [])
//   authOnNew         session/new fails with -32000 auth required
//   exitOn            'initialize' | 'session/new' | 'session/prompt': exit(3) on it
//   steps             what session/prompt does, in order:
//     { chunk: 'text' }             agent_message_chunk with text content
//     { thought: 'text' }           agent_thought_chunk
//     { update: {...} }             any other session/update payload
//     { permission: [options] }     session/request_permission, awaited
//     { ask: 'fs/read_text_file' }  any client method, awaited
//     { stop: 'end_turn' }          answer the prompt with this stopReason
//     { hang: true }                wait for session/cancel
//     { exit: 4 }                   exit with this code
//   onCancel          what to do once session/cancel arrives during a hang:
//     { permission: [options], stop: 'cancelled' } (default { stop: 'cancelled' });
//     { ignore: true } answers nothing.
//   ignoreSigterm     keep running on SIGTERM (the adapter must SIGKILL)
//   promptError       session/prompt fails with this JSON-RPC error object

const fs = require('node:fs');

const [scriptPath, recordPath] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const record = (entry) => fs.appendFileSync(recordPath, `${JSON.stringify(entry)}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

if (scenario.ignoreSigterm) process.on('SIGTERM', () => record({ sigterm: true }));
record({ start: { argv: process.argv.slice(2), cwd: process.cwd(), envNames: Object.keys(process.env).sort(), env: process.env } });

const waiting = new Map();
let nextOwnId = 0;
let cancelArrived = null;
const cancelled = new Promise((resolve) => { cancelArrived = resolve; });

const askClient = (method, params) => new Promise((resolve) => {
  const id = `agent-${nextOwnId++}`;
  waiting.set(id, resolve);
  send({ jsonrpc: '2.0', id, method, params });
});

const update = (sessionId, payload) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } });

const runPrompt = async (id, params) => {
  const { sessionId } = params;
  for (const step of scenario.steps || []) {
    if (step.chunk !== undefined) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.chunk } });
    else if (step.thought !== undefined) update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thought } });
    else if (step.update) update(sessionId, step.update);
    else if (step.permission) {
      const reply = await askClient('session/request_permission', {
        sessionId, toolCall: { toolCallId: 'call-1', title: 'run a thing' }, options: step.permission,
      });
      record({ permissionReply: reply });
    } else if (step.ask) {
      record({ askReply: { method: step.ask, reply: await askClient(step.ask, { sessionId, path: '/etc/hosts' }) } });
    } else if (step.exit !== undefined) {
      process.exit(step.exit);
    } else if (step.hang) {
      await cancelled;
      const onCancel = scenario.onCancel || { stop: 'cancelled' };
      if (onCancel.ignore) return;
      if (onCancel.permission) {
        const reply = await askClient('session/request_permission', {
          sessionId, toolCall: { toolCallId: 'call-2', title: 'late' }, options: onCancel.permission,
        });
        record({ permissionReplyAfterCancel: reply });
      }
      send({ jsonrpc: '2.0', id, result: { stopReason: onCancel.stop || 'cancelled' } });
      return;
    } else if (step.stop) {
      send({ jsonrpc: '2.0', id, result: { stopReason: step.stop } });
      return;
    }
  }
};

const handle = (msg) => {
  record({ inbound: msg });
  if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
    const resolve = waiting.get(msg.id);
    if (resolve) { waiting.delete(msg.id); resolve(msg.error ? { error: msg.error } : { result: msg.result }); }
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(msg, 'id')) {
    if (msg.method === 'session/cancel') cancelArrived();
    return;
  }
  if (scenario.exitOn === msg.method) process.exit(3);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: scenario.protocolVersion ?? 1,
      agentCapabilities: { loadSession: false, mcpCapabilities: { http: false, sse: false } },
      authMethods: scenario.authMethods || [],
      agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
    } });
    return;
  }
  if (msg.method === 'session/new') {
    if (scenario.authOnNew) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
    return;
  }
  if (msg.method === 'session/prompt' && scenario.promptError) {
    send({ jsonrpc: '2.0', id: msg.id, error: scenario.promptError });
    return;
  }
  if (msg.method === 'session/prompt') {
    runPrompt(msg.id, msg.params || {});
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
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
process.stdin.on('end', () => { if (!scenario.ignoreSigterm) process.exit(0); });
