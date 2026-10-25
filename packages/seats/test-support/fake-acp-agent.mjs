#!/usr/bin/env node
/**
 * A scripted ACP agent over stdio, for the ACP adapter's unit tests.
 *
 * Process-level behaviour comes from env:
 *   FAKE_ACP_LOG       append every message received, one JSON line each
 *   FAKE_ACP_VERSION   protocolVersion to answer initialize with (default 1)
 *   FAKE_ACP_CAPS      comma list of `resume`, `load`
 *   FAKE_ACP_FAIL      comma list of `resume`, `load` to answer with an error
 *   FAKE_ACP_FAIL_CODE that error's code as JSON (default -32002); `absent` omits it
 *
 * Turn behaviour comes from a directive in the prompt text:
 *   (none)                    thought, tool call + update, plan, usage, "PONG"
 *   [[reply:TEXT]]            reply TEXT
 *   [[stop:REASON]]           end with stopReason REASON
 *   [[permission]]            ask permission (allow_once + reject_once), reply PERM:<outcome json>
 *   [[permission-noreject]]   same, offering allow options only
 *   [[fs]]                    call fs/read_text_file and terminal/create, reply the error codes
 *   [[malformed]]             write a non-JSON line, then hang
 *   [[huge:N]]                write one N-char line, then hang
 *   [[exit]]                  write OPENAI_API_KEY to stderr and exit 3
 *   [[hang]]                  never answer until session/cancel, then stopReason cancelled
 *   [[hang-deaf]]             never answer, ignore cancel and SIGTERM
 *   [[hang-permission]]       ask permission and wait; on cancel answer cancelled
 *   [[rpc-error:CODE:MSG]]    answer the prompt with a JSON-RPC error
 *   [[echo-session]]          reply SESSION:<sessionId>
 *   [[bad-usage]]             a usage_update with a string `used` and a negative `size`, then OK
 *   [[grandchild:THEN]]       start a grandchild that ignores SIGTERM, log its pid
 *                             ({event:'grandchild', pid}), then THEN: `hang`
 *                             (answers cancel), `reply` (end_turn) or `exit` (exit 0)
 *   [[provider:N]]            POST the prompt to FAKE_ACP_PROVIDER_URL/chat/completions
 *                             up to N times (default 8), 200 ms apart, like a CLI
 *                             retrying a failing provider; ignores cancel; then
 *                             reply PROVIDER:<statuses> (PROVIDER:<text> on a 200)
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const log = (entry) => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`); };
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const caps = new Set(String(process.env.FAKE_ACP_CAPS || '').split(',').filter(Boolean));
const fails = new Set(String(process.env.FAKE_ACP_FAIL || '').split(',').filter(Boolean));
const failError = () => {
  const raw = process.env.FAKE_ACP_FAIL_CODE;
  if (raw === 'absent') return { message: 'Resource not found' };
  return { code: raw === undefined ? -32002 : JSON.parse(raw), message: 'Resource not found' };
};

let nextId = 1;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => {
  const id = `agent-${nextId}`;
  nextId += 1;
  waiting.set(id, resolve);
  write({ id, method, params });
});
const update = (sessionId, body) => write({ method: 'session/update', params: { sessionId, update: body } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

let activePrompt = null;
let deaf = false;

const PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
const ALLOW_ONLY = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always', kind: 'allow_always' },
];

const permission = (sessionId, options) => ask('session/request_permission', {
  sessionId, toolCall: { toolCallId: 'tc-1', title: process.env.FAKE_ACP_PERMISSION_TITLE || 'Edit file', kind: 'edit' }, options,
});

const runPrompt = async (id, { sessionId, prompt }) => {
  const text = (prompt || []).map((block) => block?.text || '').join('');
  const directive = /\[\[([a-z-]+)(?::([^\]]*))?\]\]/.exec(text);
  const [, kind, arg = ''] = directive || [];
  const answer = (stopReason, extra = {}) => write({ id, result: { stopReason, ...extra } });
  switch (kind) {
    case 'reply': chunk(sessionId, arg); return answer('end_turn');
    case 'stop': return answer(arg);
    case 'bad-usage':
      update(sessionId, { sessionUpdate: 'usage_update', used: '42', size: -1 });
      update(sessionId, { sessionUpdate: 'usage_update', used: 1.5, size: 1000 });
      chunk(sessionId, 'OK');
      return answer('end_turn');
    case 'echo-session': chunk(sessionId, `SESSION:${sessionId}`); return answer('end_turn');
    case 'permission':
    case 'permission-noreject': {
      const response = await permission(sessionId, kind === 'permission' ? PERMISSION_OPTIONS : ALLOW_ONLY);
      chunk(sessionId, `PERM:${JSON.stringify(response.result?.outcome ?? response.error)}`);
      return answer('end_turn');
    }
    case 'fs': {
      const read = await ask('fs/read_text_file', { sessionId, path: '/etc/hosts' });
      const term = await ask('terminal/create', { sessionId, command: 'ls' });
      chunk(sessionId, `FS:${read.error?.code} TERM:${term.error?.code}`);
      return answer('end_turn');
    }
    case 'malformed': process.stdout.write('this is not json\n'); return undefined;
    case 'huge': process.stdout.write(`${'x'.repeat(Number(arg) || 1000)}\n`); return undefined;
    case 'exit':
      process.stderr.write(`fatal: provider rejected key ${process.env.OPENAI_API_KEY}\n`);
      setTimeout(() => process.exit(3), 10);
      return undefined;
    case 'hang': activePrompt = { id, sessionId }; return undefined;
    case 'hang-deaf': deaf = true; process.on('SIGTERM', () => log({ event: 'sigterm-ignored' })); return undefined;
    case 'hang-permission': {
      activePrompt = { id, sessionId };
      const response = await permission(sessionId, PERMISSION_OPTIONS);
      log({ event: 'permission-answer', outcome: response.result?.outcome });
      return undefined;
    }
    case 'grandchild': {
      const grandchild = spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise((resolve) => { grandchild.stdout.once('data', resolve); });
      log({ event: 'grandchild', pid: grandchild.pid });
      if (arg === 'reply') { chunk(sessionId, 'SPAWNED'); return answer('end_turn'); }
      if (arg === 'exit') { setTimeout(() => process.exit(0), 10); return undefined; }
      activePrompt = { id, sessionId };
      return undefined;
    }
    case 'provider': {
      const statuses = [];
      for (let attempt = 0; attempt < (Number(arg) || 8); attempt += 1) {
        let status = 0;
        let body = null;
        try {
          const answer = await fetch(`${process.env.FAKE_ACP_PROVIDER_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: text }] }),
          });
          status = answer.status;
          body = await answer.json().catch(() => null);
        } catch { status = -1; }
        log({ event: 'provider-attempt', status });
        statuses.push(status);
        if (status === 200) {
          chunk(sessionId, `PROVIDER:${body?.choices?.[0]?.message?.content}`);
          return answer('end_turn');
        }
        await new Promise((resolve) => { setTimeout(resolve, 200); });
      }
      chunk(sessionId, `PROVIDER:${statuses.join(',')}`);
      return answer('end_turn');
    }
    case 'rpc-error': {
      const [code, ...message] = arg.split(':');
      return write({ id, error: { code: Number(code), message: message.join(':') } });
    }
    default:
      update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking hard' } });
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read file', kind: 'read', status: 'pending' });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' });
      update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'answer', priority: 'high', status: 'completed' }] });
      update(sessionId, { sessionUpdate: 'usage_update', used: 42, size: 1000 });
      update(sessionId, { sessionUpdate: 'a_kind_from_the_future', anything: true });
      write({ method: 'x/unknown_notification', params: {} });
      update('some-other-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRONG' } });
      chunk(sessionId, 'PO');
      chunk(sessionId, 'NG');
      return answer('end_turn', { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
  }
};

const handle = (message) => {
  log(message);
  if (!message.method) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return write({
        id,
        result: {
          protocolVersion: Number(process.env.FAKE_ACP_VERSION || 1),
          agentCapabilities: {
            loadSession: caps.has('load'),
            sessionCapabilities: caps.has('resume') ? { resume: {} } : {},
          },
          authMethods: [],
        },
      });
    case 'session/new': return write({ id, result: { sessionId: 'sess-new-1' } });
    case 'session/resume':
      if (fails.has('resume')) return write({ id, error: failError() });
      return write({ id, result: {} });
    case 'session/load':
      if (fails.has('load')) return write({ id, error: failError() });
      chunk(params.sessionId, 'REPLAYED');
      return write({ id, result: {} });
    case 'session/prompt': return runPrompt(id, params);
    case 'session/cancel':
      if (deaf) return undefined;
      if (activePrompt) {
        write({ id: activePrompt.id, result: { stopReason: 'cancelled' } });
        activePrompt = null;
      }
      return undefined;
    default:
      if (id !== undefined) write({ id, error: { code: -32601, message: `unknown ${method}` } });
      return undefined;
  }
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => { if (!deaf) process.exit(0); });
