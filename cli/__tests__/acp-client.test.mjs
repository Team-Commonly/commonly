/**
 * acp-client.test.mjs — the ACP adapter's JSON-RPC 2.0 client
 * core over a child's stdio. Most cases drive a real child, the scripted fake
 * agent in fixtures/fake-acp-agent.cjs; the byte-exact framing cases use
 * in-memory streams so the chunk boundaries are certain.
 */

import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpConnection, ACP_ERROR } from '../src/lib/acp/client.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.cjs');

const children = [];
const startAgent = (scenario = 'default', options = {}) => {
  const child = spawn(process.execPath, [FAKE, scenario], { stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  const logs = [];
  const notifications = [];
  const conn = createAcpConnection({
    stdin: child.stdin,
    stdout: child.stdout,
    onNotification: (method, params) => notifications.push({ method, params }),
    log: (line) => logs.push(line),
    ...options,
  });
  return { child, conn, logs, notifications };
};

afterEach(() => {
  while (children.length) { const c = children.pop(); if (c.exitCode === null) c.kill('SIGKILL'); }
});

// An in-memory pair: `agentOut` is what the agent writes (client reads),
// `written` collects what the client writes to the agent.
const memoryPair = (options = {}) => {
  const agentOut = new PassThrough();
  const clientOut = new PassThrough();
  const written = [];
  clientOut.setEncoding('utf8');
  clientOut.on('data', (d) => written.push(d));
  const logs = [];
  const notifications = [];
  const conn = createAcpConnection({
    stdin: clientOut,
    stdout: agentOut,
    onNotification: (method, params) => notifications.push({ method, params }),
    log: (line) => logs.push(line),
    ...options,
  });
  const sentMessages = () => written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { agentOut, written, sentMessages, conn, logs, notifications };
};
const tick = () => new Promise((r) => setImmediate(r));
const hasOwnId = (m) => Object.prototype.hasOwnProperty.call(m, 'id');

describe('ACP client: requests and responses', () => {
  test('a request resolves with the result', async () => {
    const { conn } = startAgent();
    await expect(conn.request('echo', { hello: 'world' })).resolves.toEqual({ echoed: { hello: 'world' } });
    conn.close('done');
  });

  test('an error response rejects with the JSON-RPC code, message and data', async () => {
    const { conn } = startAgent();
    const err = await conn.request('fail', {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(-32002);
    expect(err.message).toMatch(/Resource not found/);
    expect(err.data).toEqual({ sessionId: 'sess_missing' });
    conn.close('done');
  });

  test('notifications interleaved with a pending request reach onNotification before the result', async () => {
    const { conn, notifications } = startAgent();
    const result = await conn.request('stream-updates', { sessionId: 's1' });
    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(notifications.map((n) => n.params.seq)).toEqual([0, 1, 2]);
    expect(notifications.every((n) => n.method === 'session/update')).toBe(true);
    conn.close('done');
  });

  test('request ids are unique and monotonic', async () => {
    const { conn, sentMessages } = memoryPair();
    conn.request('a').catch(() => {});
    conn.request('b').catch(() => {});
    conn.request('c').catch(() => {});
    await tick();
    const ids = sentMessages().map((m) => m.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0] < ids[1] && ids[1] < ids[2]).toBe(true);
    expect(sentMessages().every((m) => m.jsonrpc === '2.0')).toBe(true);
    conn.close('done');
  });

  test('notify sends a message with no id', async () => {
    const { conn } = startAgent();
    conn.notify('session/cancel', { sessionId: 's1' });
    const { inbox } = await conn.request('inbox');
    expect(inbox).toEqual([{ notification: 'session/cancel', params: { sessionId: 's1' } }]);
    conn.close('done');
  });

  test('an outbound message with a newline in a string is still one line', async () => {
    const { conn, written } = memoryPair();
    conn.notify('note', { text: 'a\nb\r\nc' });
    await tick();
    expect(written.join('')).toBe(`${JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { text: 'a\nb\r\nc' } })}\n`);
    expect(written.join('').split('\n')).toHaveLength(2);
    conn.close('done');
  });
});

describe('ACP client: requests from the agent', () => {
  test('an agent-side request mid-turn is answered by onRequest', async () => {
    const seen = [];
    const { conn } = startAgent('default', {
      onRequest: async (method, params) => { seen.push({ method, params }); return { outcome: { outcome: 'selected', optionId: 'allow' } }; },
    });
    const result = await conn.request('ask-permission', {});
    expect(seen).toEqual([{ method: 'session/request_permission', params: expect.objectContaining({ sessionId: 's1' }) }]);
    expect(result).toEqual({ permissionReply: { result: { outcome: { outcome: 'selected', optionId: 'allow' } } } });
    conn.close('done');
  });

  test('a method with no handler gets -32601', async () => {
    const { conn } = startAgent();
    const { reply } = await conn.request('ask-unknown', {});
    expect(reply.error.code).toBe(-32601);
    conn.close('done');
  });

  test('a method onRequest refuses with a code gets that JSON-RPC error', async () => {
    const { conn } = startAgent('default', {
      onRequest: (method) => {
        if (method === 'fs/read_text_file') {
          const e = new Error('Resource not found'); e.code = ACP_ERROR.RESOURCE_NOT_FOUND; e.data = { path: '/nope' }; throw e;
        }
        const e = new Error('Method not found'); e.code = ACP_ERROR.METHOD_NOT_FOUND; throw e;
      },
    });
    expect((await conn.request('ask-failing', {})).reply.error).toEqual({ code: -32002, message: 'Resource not found', data: { path: '/nope' } });
    expect((await conn.request('ask-unknown', {})).reply.error.code).toBe(-32601);
    conn.close('done');
  });

  test('an onRequest crash without a code is an internal error that does not echo the message', async () => {
    const { conn } = startAgent('default', { onRequest: () => { throw new Error('token sk-abc leaked'); } });
    const { reply } = await conn.request('ask-unknown', {});
    expect(reply.error.code).toBe(-32603);
    expect(JSON.stringify(reply.error)).not.toMatch(/sk-abc/);
    conn.close('done');
  });

  test('an inbound notification never gets a response, known or not', async () => {
    const { conn } = startAgent('default', { onNotification: () => { throw new Error('handler broke'); } });
    await conn.request('notify-unknown', {});
    await conn.request('stream-updates', { sessionId: 's1' });
    const { inbox } = await conn.request('inbox');
    expect(inbox).toEqual([]);
    conn.close('done');
  });
});

describe('ACP client: framing', () => {
  test('a JSON line split across chunks from a real child', async () => {
    const { conn } = startAgent();
    await expect(conn.request('split-reply', {})).resolves.toEqual({ split: true, text: 'line\nbreak' });
    conn.close('done');
  });

  test('a line split byte by byte, through a multi-byte character', async () => {
    const { agentOut, conn, sentMessages } = memoryPair();
    const pending = conn.request('anything');
    await tick();
    const [{ id }] = sentMessages();
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result: { text: 'héllo 世界 🙂' } })}\n`);
    for (const b of bytes) { agentOut.write(Buffer.from([b])); }
    await expect(pending).resolves.toEqual({ text: 'héllo 世界 🙂' });
    conn.close('done');
  });

  test('two messages in one chunk', async () => {
    const { conn, notifications } = startAgent();
    await expect(conn.request('two-in-one', { sessionId: 's9' })).resolves.toEqual({ together: true });
    expect(notifications).toEqual([{ method: 'session/update', params: { sessionId: 's9', seq: 0 } }]);
    conn.close('done');
  });

  test('a garbage line is skipped and logged truncated, and the connection carries on', async () => {
    const { conn, logs } = startAgent();
    await expect(conn.request('garbage-then-reply', {})).resolves.toEqual({ afterGarbage: true });
    await expect(conn.request('echo', { still: 'alive' })).resolves.toEqual({ echoed: { still: 'alive' } });
    const all = logs.join('\n');
    expect(all).toMatch(/not JSON/i);
    expect(all).not.toMatch(/Bearer/);
    expect(all).not.toMatch(/sk-SECRET/);
    expect(all).not.toMatch(/IDSECRET/);
    expect(all).toMatch(/bytes/);
    conn.close('done');
  });

  test('a message over the size cap closes the connection and rejects what is pending', async () => {
    const { conn, logs } = startAgent('default', { maxMessageBytes: 4096 });
    const err = await conn.request('big-reply', { bytes: 10000 }).catch((e) => e);
    expect(err.code).toBe('ACP_CLOSED');
    expect(err.message).toMatch(/4096/);
    expect(conn.isClosed()).toBe(true);
    expect(logs.join('\n')).not.toMatch(/xxxxxxxxxx/);
  });

  test('a message under the cap passes', async () => {
    const { conn } = startAgent('default', { maxMessageBytes: 4096 });
    const result = await conn.request('big-reply', { bytes: 3000 });
    expect(result.blob).toHaveLength(3000);
    conn.close('done');
  });
});

describe('ACP client: lifecycle', () => {
  test('a crash mid-request rejects with a clear error', async () => {
    const { conn } = startAgent();
    const err = await conn.request('crash-mid', {}).catch((e) => e);
    expect(err.code).toBe('ACP_CLOSED');
    expect(err.message).toMatch(/agent stdout ended/);
    await expect(conn.closed).resolves.toMatch(/agent stdout ended/);
  });

  test('a crash on the first request rejects it', async () => {
    const { conn } = startAgent('crash-on-request');
    const err = await conn.request('echo', {}).catch((e) => e);
    expect(err.code).toBe('ACP_CLOSED');
  });

  test('a per-request timeout rejects that request only', async () => {
    const { conn } = startAgent();
    const err = await conn.request('hang', {}, { timeoutMs: 50 }).catch((e) => e);
    expect(err.code).toBe('ACP_TIMEOUT');
    expect(err.message).toMatch(/hang/);
    expect(err.message).toMatch(/50/);
    await expect(conn.request('echo', { ok: 1 })).resolves.toEqual({ echoed: { ok: 1 } });
    conn.close('done');
  });

  test('close rejects every pending request, and later calls fail fast', async () => {
    const { conn } = startAgent();
    const a = conn.request('hang', {}).catch((e) => e);
    const b = conn.request('hang', {}).catch((e) => e);
    conn.close('turn finished');
    for (const err of await Promise.all([a, b])) {
      expect(err.code).toBe('ACP_CLOSED');
      expect(err.message).toMatch(/turn finished/);
    }
    await expect(conn.request('echo', {})).rejects.toMatchObject({ code: 'ACP_CLOSED' });
    expect(() => conn.notify('x', {})).not.toThrow();
    conn.close('again'); // idempotent
    await expect(conn.closed).resolves.toBe('turn finished');
  });

  test('a stdout error closes the connection', async () => {
    const { agentOut, conn } = memoryPair();
    const pending = conn.request('anything').catch((e) => e);
    agentOut.destroy(Object.assign(new Error('boom'), { code: 'EPIPE' }));
    const err = await pending;
    expect(err.code).toBe('ACP_CLOSED');
    expect(err.message).toMatch(/stdout error/);
  });

  test('logs name methods and ids, never params', async () => {
    const { conn, logs } = startAgent('default', { onRequest: () => ({}) });
    await conn.request('echo', { secret: 'sk-live-ZZZ' });
    await conn.request('ask-permission', {});
    conn.notify('session/cancel', { token: 'sk-live-YYY' });
    conn.close('done');
    const all = logs.join('\n');
    expect(all).not.toMatch(/sk-live/);
    expect(all).toMatch(/echo/);
  });
});

describe('ACP client: encoding failures stay with their call', () => {
  test('a BigInt param rejects that request only', async () => {
    const { conn } = startAgent();
    const err = await conn.request('echo', { n: 1n }).catch((e) => e);
    expect(err.code).toBe('ACP_ENCODE');
    expect(conn.isClosed()).toBe(false);
    await expect(conn.request('echo', { n: 1 })).resolves.toEqual({ echoed: { n: 1 } });
    conn.close('done');
  });

  test('a notify that cannot be encoded throws to its caller only', async () => {
    const { conn } = startAgent();
    expect(() => conn.notify('session/cancel', { n: 1n })).toThrow(expect.objectContaining({ code: 'ACP_ENCODE' }));
    await expect(conn.request('echo', { ok: true })).resolves.toEqual({ echoed: { ok: true } });
    conn.close('done');
  });

  test('a circular onRequest result becomes -32603 and the connection carries on', async () => {
    const circular = { a: 1 }; circular.self = circular;
    const { conn } = startAgent('default', { onRequest: () => circular });
    const { reply } = await conn.request('ask-unknown', {});
    expect(reply.error).toEqual({ code: -32603, message: 'Internal error' });
    await expect(conn.request('echo', { next: 1 })).resolves.toEqual({ echoed: { next: 1 } });
    conn.close('done');
  });

  test('a circular err.data becomes -32603 and the connection carries on', async () => {
    const data = {}; data.self = data;
    const { conn } = startAgent('default', {
      onRequest: () => { throw Object.assign(new Error('Resource not found'), { code: -32002, data }); },
    });
    const { reply } = await conn.request('ask-failing', {});
    expect(reply.error).toEqual({ code: -32603, message: 'Internal error' });
    await expect(conn.request('echo', { next: 2 })).resolves.toEqual({ echoed: { next: 2 } });
    conn.close('done');
  });
});

describe('ACP client: what the agent controls is clamped before it is logged', () => {
  test('a long inbound method with newlines is logged short and on one line', async () => {
    const { agentOut, conn, logs, sentMessages } = memoryPair();
    const method = `evil\nFAKE LOG LINE\r\n${'m'.repeat(100000)}`;
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'r1', method, params: {} })}\n`);
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: {} })}\n`);
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id: { bad: 1 }, method })}\n`);
    await tick();
    const pending = conn.request('x');
    await tick();
    const { id } = sentMessages().find((m) => m.method === 'x');
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: `${'c'.repeat(5000)}\nINJECTED`, message: 'm' } })}\n`);
    await pending.catch(() => {});
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(line.length).toBeLessThan(300);
    }
    conn.close('done');
  });

  test('a string id and an unknown method are logged by size only, never their text', async () => {
    const { agentOut, conn, logs, sentMessages } = memoryPair({
      onRequest: async () => { throw new Error('no'); },
    });
    // Built at runtime: a key-shaped literal here would trip the repo's secret scan.
    const secret = ['agent', 'chosen', 'text'].join('-') + 'q'.repeat(24);
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id: secret, method: `x/${secret}`, params: {} })}\n`);
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', method: `y/${secret}`, params: {} })}\n`);
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id: secret, method: 'fs/read_text_file', params: {} })}\n`);
    await tick(); await tick();
    // The reply still echoes the id: only the log withholds it.
    expect(sentMessages().filter((m) => m.id === secret)).toHaveLength(2);
    expect(logs.join('\n')).not.toContain(secret);
    expect(logs.join('\n')).toContain('fs/read_text_file');
    expect(logs.join('\n')).toMatch(/unknown method \(\d+ chars\)/);
    conn.close('done');
  });

  test('an error code that cannot become a string settles its request as invalid', async () => {
    const { agentOut, conn, sentMessages } = memoryPair();
    const first = conn.request('a').catch((e) => e);
    await tick();
    const [{ id }] = sentMessages();
    // JSON.parse gives an object whose own toString is null: String() on it throws.
    agentOut.write(`{"jsonrpc":"2.0","id":${id},"error":{"code":{"toString":null},"message":"bad"}}\n`);
    const err = await first;
    expect(err.code).toBe('ACP_INVALID_RESPONSE');
    // The connection carries on.
    const second = conn.request('b');
    await tick();
    const { id: id2 } = sentMessages().find((m) => m.method === 'b');
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id: id2, result: { ok: 1 } })}\n`);
    await expect(second).resolves.toEqual({ ok: 1 });
    conn.close('done');
  });

  test.each([
    ['a string code', { code: '-32603', message: 'x' }],
    ['a fractional code', { code: 1.5, message: 'x' }],
    ['a null error', null],
    ['an array error', [1]],
  ])('an error object with %s rejects as invalid', async (_label, error) => {
    const { agentOut, conn, sentMessages } = memoryPair();
    const pending = conn.request('a').catch((e) => e);
    await tick();
    const [{ id }] = sentMessages();
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
    const err = await pending;
    expect(err.code).toBe('ACP_INVALID_RESPONSE');
    expect(conn.isClosed()).toBe(false);
    conn.close('done');
  });
});

describe('ACP client: null request ids', () => {
  test('an inbound request with a null id reaches onRequest and its reply keeps the null id', async () => {
    const calls = [];
    const { agentOut, conn, sentMessages } = memoryPair({
      onRequest: async (method, params) => { calls.push({ method, params }); return { granted: true }; },
    });
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, method: 'session/request_permission', params: { p: 1 } })}\n`);
    await tick(); await tick();
    expect(calls).toEqual([{ method: 'session/request_permission', params: { p: 1 } }]);
    const reply = sentMessages().find((m) => hasOwnId(m) && m.id === null);
    expect(reply).toEqual({ jsonrpc: '2.0', id: null, result: { granted: true } });
    conn.close('done');
  });
});

describe('ACP client: more framing and response shapes', () => {
  test('CRLF line endings frame like LF', async () => {
    const { agentOut, conn, notifications, sentMessages } = memoryPair();
    const pending = conn.request('a');
    await tick();
    const [{ id }] = sentMessages();
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { n: 1 } })}\r\n`
      + `${JSON.stringify({ jsonrpc: '2.0', id, result: { crlf: true } })}\r\n`);
    await expect(pending).resolves.toEqual({ crlf: true });
    expect(notifications).toEqual([{ method: 'session/update', params: { n: 1 } }]);
    conn.close('done');
  });

  test('a null-id response is ignored and other requests still complete', async () => {
    const { agentOut, conn, sentMessages } = memoryPair();
    const pending = conn.request('a');
    await tick();
    const [{ id }] = sentMessages();
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { fine: true } })}\n`);
    await expect(pending).resolves.toEqual({ fine: true });
    expect(conn.isClosed()).toBe(false);
    conn.close('done');
  });

  test('a late response after a timeout is ignored without a throw', async () => {
    const { agentOut, conn, sentMessages } = memoryPair();
    const err = await conn.request('slow', {}, { timeoutMs: 20 }).catch((e) => e);
    expect(err.code).toBe('ACP_TIMEOUT');
    const [{ id }] = sentMessages();
    expect(() => agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { late: true } })}\n`)).not.toThrow();
    await tick();
    const next = conn.request('b');
    await tick();
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id: sentMessages()[1].id, result: { ok: 1 } })}\n`);
    await expect(next).resolves.toEqual({ ok: 1 });
    conn.close('done');
  });

  test('a response with both result and error rejects that request as invalid', async () => {
    const { agentOut, conn, sentMessages } = memoryPair();
    const pending = conn.request('a').catch((e) => e);
    await tick();
    const [{ id }] = sentMessages();
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: {}, error: { code: -32603, message: 'x' } })}\n`);
    const err = await pending;
    expect(err.code).toBe('ACP_INVALID_RESPONSE');
    expect(conn.isClosed()).toBe(false);
    conn.close('done');
  });

  test('onRequest settling after close writes nothing', async () => {
    let fail;
    const { agentOut, conn, written } = memoryPair({
      onRequest: () => new Promise((_resolve, reject) => { fail = reject; }),
    });
    agentOut.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: {} })}\n`);
    await tick();
    conn.close('turn over');
    const before = written.join('');
    fail(Object.assign(new Error('nope'), { code: -32002 }));
    await tick(); await tick();
    expect(written.join('')).toBe(before);
    expect(before).toBe('');
  });

  test('a partial line with no newline that passes the cap closes the connection', async () => {
    const { agentOut, conn } = memoryPair({ maxMessageBytes: 1024 });
    const pending = conn.request('a').catch((e) => e);
    await tick();
    agentOut.write('{"jsonrpc":"2.0","id":0,"result":"');
    agentOut.write('y'.repeat(600));
    expect(conn.isClosed()).toBe(false);
    agentOut.write('y'.repeat(600));
    const err = await pending;
    expect(err.code).toBe('ACP_CLOSED');
    expect(err.message).toMatch(/1024/);
  });
});
