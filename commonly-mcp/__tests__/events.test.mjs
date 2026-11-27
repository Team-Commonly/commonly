/**
 * MCP Events (spike, off by default): the server offers Commonly @mentions and
 * task assignments as `io.modelcontextprotocol/events` push subscriptions.
 *
 * Driven with raw JSON-RPC over the SDK's in-memory transport, because the
 * extension is defined for protocol 2026-07-28 (`server/discover`, no
 * initialize) and the SDK's v1 client cannot speak it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { parseRetryAfter } from '../src/client.js';
import {
  EVENTS_EXTENSION,
  MENTION_EVENT,
  TASK_EVENT,
  eventsRequested,
  occurrenceFor,
  stopOnSignals,
} from '../src/events.js';
import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

const TOKEN = 'cm_agent_secret_never_shown';
const cfg = { baseUrl: 'https://x.example', token: TOKEN };
const SUB = 'io.modelcontextprotocol/subscriptionId';
const EVENTS_PATH = '/api/agents/runtime/events';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const waitFor = async (check, ms = 2000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(5);
  }
  return false;
};

const mention = (id, extra = {}) => ({
  _id: id,
  type: 'chat.mention',
  podId: 'pod1',
  createdAt: '2026-11-26T10:00:00.000Z',
  payload: {
    messageId: '41',
    deliveryId: `d-${id}`,
    userId: 'u1',
    username: 'sam',
    senderIsHuman: true,
    rawContent: '@bot can you look at the failing build?',
    content: '[framed wake text]\n\n@bot can you look at the failing build?',
    ...extra,
  },
});

const assignment = (id) => ({
  _id: id,
  type: 'message.posted',
  podId: 'pod1',
  createdAt: '2026-11-26T10:01:00.000Z',
  payload: {
    deliveryId: `d-${id}`,
    boardWake: true,
    wakeReason: 'assignee',
    taskId: 'row-7',
    taskKind: 'updated',
    content: 'Your board changed.\n- row-7: fix the build',
  },
});

/** A stub CAP backend: each GET /events answers the next scripted page. */
const scriptedApi = (pages = []) => {
  const calls = [];
  let page = 0;
  const requestImpl = async (config, { method, path, body, query }) => {
    calls.push({ method, path, body, query, token: config.token });
    if (path === EVENTS_PATH && method === 'GET') {
      const next = pages[page];
      page += 1;
      return { events: next || [] };
    }
    return { success: true };
  };
  return { calls, requestImpl, polls: () => calls.filter((c) => c.path === EVENTS_PATH).length };
};

/** A promise the test settles by hand. */
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** A CAP backend whose next poll returns whatever the test queued. */
const queuedApi = () => {
  const queue = [];
  const calls = [];
  const requestImpl = async (config, { method, path, body }) => {
    calls.push({ method, path, body });
    if (path === EVENTS_PATH && method === 'GET') return { events: queue.splice(0) };
    return { success: true };
  };
  return { queue, calls, requestImpl };
};

const isEvent = (message, subscription, eventId) => message?.method === 'notifications/events/event'
  && (subscription === undefined || message.params._meta[SUB] === subscription)
  && (eventId === undefined || message.params.eventId === eventId);

/** A raw JSON-RPC peer on the in-memory transport. */
const rawPeer = async (handle, { delayMs = 0, intercept = null } = {}) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  if (delayMs) {
    // Backpressure: every server write takes this long to land.
    const send = serverSide.send.bind(serverSide);
    serverSide.send = async (message, options) => { await sleep(delayMs); return send(message, options); };
  }
  if (intercept) {
    // A test decides how each server write lands: hold it, fail it, or pass it on.
    const send = serverSide.send.bind(serverSide);
    serverSide.send = (message, options) => intercept(message, () => send(message, options));
  }
  const seen = [];
  const waiting = new Map();
  clientSide.onmessage = (message) => {
    seen.push(message);
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  };
  await handle.connect(serverSide);
  await clientSide.start();
  let next = 100;
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
  const send = (method, params = {}, id = (next += 1)) => {
    const answered = new Promise((resolve) => { waiting.set(id, resolve); });
    clientSide.send({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } });
    return { id, answered };
  };
  const notifications = (method) => seen.filter((m) => m.method === method);
  const cancel = (requestId) => clientSide.send({
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId },
  });
  return {
    send, seen, notifications, cancel, close: () => clientSide.close(), raw: (message) => clientSide.send(message),
  };
};

const quiet = { log: () => {}, intervalMs: 5, busyDelayMs: 1 };

describe('the flag', () => {
  it('is off unless COMMONLY_MCP_EVENTS is truthy or --events is passed', () => {
    expect(eventsRequested({ env: {}, argv: [] })).toBe(false);
    expect(eventsRequested({ env: { COMMONLY_MCP_EVENTS: '0' }, argv: [] })).toBe(false);
    expect(eventsRequested({ env: { COMMONLY_MCP_EVENTS: '1' }, argv: [] })).toBe(true);
    expect(eventsRequested({ env: { COMMONLY_MCP_EVENTS: 'true' }, argv: [] })).toBe(true);
    expect(eventsRequested({ env: {}, argv: ['--events'] })).toBe(true);
  });
});

describe('events off (the default)', () => {
  it('declares exactly what it did before, answers no events/* or server/discover, and never polls', async () => {
    const api = scriptedApi([[mention('e1')]]);
    const handle = createServer(cfg, { env: {}, eventsOptions: { ...quiet, requestImpl: api.requestImpl } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-host', version: '0.0.0' });
    await handle.connect(serverSide);
    await client.connect(clientSide);
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    expect(client.getInstructions()).toBeUndefined();
    await expect(client.request({ method: 'server/discover', params: {} }, { parse: (x) => x }))
      .rejects.toMatchObject({ code: -32601 });
    await expect(client.request({ method: 'events/list', params: {} }, { parse: (x) => x }))
      .rejects.toMatchObject({ code: -32601 });
    await sleep(30);
    expect(api.calls).toHaveLength(0);
    expect(handle.events).toBeNull();
    await client.close();
  });

  it('lists the same tools with and without the flag', async () => {
    const list = async (events) => {
      const handle = createServer(cfg, { env: {}, events, eventsOptions: quiet });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-host', version: '0.0.0' });
      await handle.connect(serverSide);
      await client.connect(clientSide);
      const { tools } = await client.listTools();
      await client.close();
      return JSON.stringify(tools);
    };
    expect(await list(true)).toBe(await list(false));
  });
});

describe('events on', () => {
  const on = (api, extra = {}) => createServer(cfg, {
    env: {}, events: true, eventsOptions: { ...quiet, requestImpl: api.requestImpl, epoch: 'ep1', ...extra },
  });

  it('advertises the extension through server/discover (2026-07-28) and at initialize', async () => {
    const api = scriptedApi();
    const peer = await rawPeer(on(api));
    const discovered = await peer.send('server/discover').answered;
    expect(discovered.result.supportedVersions).toEqual(['2026-07-28']);
    expect(discovered.result.capabilities).toEqual({ tools: {}, extensions: { [EVENTS_EXTENSION]: {} } });
    expect(discovered.result.resultType).toBe('complete');
    expect(discovered.result).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
    expect(discovered.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('@commonlyai/mcp');

    const legacy = await peer.send('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' },
    }).answered;
    expect(legacy.result.capabilities.extensions).toEqual({ [EVENTS_EXTENSION]: {} });
    await peer.close();
  });

  it('adds resultType to every 2026-07-28 result, and leaves legacy results as they were', async () => {
    const api = scriptedApi();
    const peer = await rawPeer(on(api));
    const modern = await peer.send('tools/list').answered;
    expect(modern.result.resultType).toBe('complete');
    expect(modern.result.ttlMs).toBe(0);
    expect(modern.result.cacheScope).toBe('private');
    expect(modern.result.tools.length).toBeGreaterThan(0);
    const id = 9001;
    try {
      // No 2026-07-28 envelope in _meta: a legacy request.
      await peer.raw({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
      expect(await waitFor(() => peer.seen.some((m) => m.id === id))).toBe(true);
      const legacy = peer.seen.find((m) => m.id === id);
      expect(legacy.result.resultType).toBeUndefined();
      expect(legacy.result.ttlMs).toBeUndefined();
    } finally {
      await peer.close();
    }
  });

  it('marks a 2026-07-28 request the transport delivers while it starts', async () => {
    const handle = on(scriptedApi());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const seen = [];
    clientSide.onmessage = (message) => { seen.push(message); };
    // Sent before connect: the in-memory transport queues it and hands it
    // over from start(), as a transport with buffered input would.
    await clientSide.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    });
    try {
      await handle.connect(serverSide);
      expect(await waitFor(() => seen.some((m) => m.id === 5))).toBe(true);
      const reply = seen.find((m) => m.id === 5);
      expect(reply.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    } finally {
      await clientSide.close();
    }
  });

  it('lists exactly the mention and task-assignment event types, push only, and polls nothing yet', async () => {
    const api = scriptedApi([[mention('e1')]]);
    const peer = await rawPeer(on(api));
    const { result } = await peer.send('events/list').answered;
    expect(result.resultType).toBe('complete');
    expect(result.events.map((e) => e.name)).toEqual([MENTION_EVENT, TASK_EVENT]);
    for (const type of result.events) {
      expect(type.delivery).toEqual(['push']);
      expect(type.inputSchema.type).toBe('object');
      expect(type.payloadSchema.type).toBe('object');
      expect(type.description).toMatch(/untrusted/i);
    }
    await sleep(30);
    expect(api.polls()).toBe(0);
    await peer.close();
  });

  it('refuses an event type it does not offer, poll delivery and webhooks', async () => {
    const api = scriptedApi();
    const peer = await rawPeer(on(api));
    const unknown = await peer.send('events/stream', { name: 'message.posted' }).answered;
    expect(unknown.error.code).toBe(-32023);
    const badArgs = await peer.send('events/stream', { name: MENTION_EVENT, arguments: { pod: 1 } }).answered;
    expect(badArgs.error.code).toBe(-32602);
    const poll = await peer.send('events/poll', { name: MENTION_EVENT, cursor: null }).answered;
    expect(poll.error).toMatchObject({ code: -32026, data: { feature: 'deliveryMode', value: 'poll' } });
    const hook = await peer.send('events/subscribe', { name: MENTION_EVENT }).answered;
    expect(hook.error).toMatchObject({ code: -32026, data: { feature: 'deliveryMode', value: 'webhook' } });
    expect(api.polls()).toBe(0);
    await peer.close();
  });

  it('subscribes with events/stream and pushes a mention with the payload an agent acts on, then acks it', async () => {
    const api = scriptedApi([[mention('e1')]]);
    const peer = await rawPeer(on(api));
    const stream = peer.send('events/stream', { name: MENTION_EVENT, cursor: null, heartbeatMs: 15000 });

    await waitFor(() => peer.notifications('notifications/events/event').length === 1);
    const [active] = peer.notifications('notifications/events/active');
    expect(active.params).toEqual({
      cursor: 'ep1:0', truncated: false, heartbeatMs: 15000, _meta: { [SUB]: stream.id },
    });
    const [event] = peer.notifications('notifications/events/event');
    expect(event.params).toEqual({
      eventId: 'e1',
      name: MENTION_EVENT,
      timestamp: '2026-11-26T10:00:00.000Z',
      data: {
        podId: 'pod1',
        messageId: '41',
        threadRootId: '',
        senderId: 'u1',
        senderName: 'sam',
        eventType: 'chat.mention',
        excerpt: '@bot can you look at the failing build?',
      },
      cursor: 'ep1:1',
      _meta: { [SUB]: stream.id },
    });
    await waitFor(() => api.calls.some((c) => c.path.endsWith('/ack')));
    const ack = api.calls.find((c) => c.path.endsWith('/ack'));
    expect(ack.path).toBe(`${EVENTS_PATH}/e1/ack`);
    expect(ack.body).toEqual({
      result: { outcome: 'acknowledged', reason: 'delivered as an MCP event' }, deliveryId: 'd-e1',
    });
    await peer.close();
  });

  it('pushes a task assignment on its own stream', async () => {
    const api = scriptedApi([[assignment('t1')]]);
    const peer = await rawPeer(on(api));
    peer.send('events/stream', { name: TASK_EVENT });
    await waitFor(() => peer.notifications('notifications/events/event').length === 1);
    const [event] = peer.notifications('notifications/events/event');
    expect(event.params.name).toBe(TASK_EVENT);
    expect(event.params.data).toEqual({
      podId: 'pod1', taskId: 'row-7', taskKind: 'updated', excerpt: 'Your board changed. - row-7: fix the build',
    });
    await peer.close();
  });

  it('acks other claimed events without a push, and offers no other event types', async () => {
    const api = scriptedApi([[
      { _id: 'h1', type: 'heartbeat', podId: 'pod1', payload: { deliveryId: 'd-h1' } },
      { _id: 'm1', type: 'message.posted', podId: 'pod1', payload: { deliveryId: 'd-m1', content: 'hi' } },
      { _id: 'g1', ...mention('g1'), deliveryMode: 'digest' },
      mention('k1', { triggerAuthor: 'kernel', assignedTaskWake: true }),
      mention('e1'),
    ]]);
    const peer = await rawPeer(on(api));
    peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => api.calls.filter((c) => c.path.endsWith('/ack')).length === 5);
    const events = peer.notifications('notifications/events/event');
    expect(events.map((e) => e.params.eventId)).toEqual(['e1']);
    const acks = api.calls.filter((c) => c.path.endsWith('/ack'));
    for (const id of ['h1', 'm1', 'g1', 'k1']) {
      const one = acks.find((c) => c.path === `${EVENTS_PATH}/${id}/ack`);
      expect(one.body.result.outcome).toBe('no_action');
      expect(one.body.result.reason).toMatch(/^events mode: /);
    }
    await peer.close();
  });

  it('resumes from a cursor without duplicates, and replays only what came after it', async () => {
    const api = scriptedApi([[mention('e1')], [mention('e2')]]);
    const handle = on(api);
    const peer = await rawPeer(handle);
    const first = peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => peer.notifications('notifications/events/event').length === 2);
    const cursorAfterE1 = peer.notifications('notifications/events/event')[0].params.cursor;
    peer.cancel(first.id);
    await waitFor(() => handle.events.streamCount === 0);
    await handle.events.done();
    const pollsAfterCancel = api.polls();
    await sleep(30);
    // No open stream: nothing more is claimed.
    expect(api.polls()).toBe(pollsAfterCancel);

    const second = peer.send('events/stream', { name: MENTION_EVENT, cursor: cursorAfterE1 });
    await waitFor(() => peer.notifications('notifications/events/event')
      .filter((n) => n.params._meta[SUB] === second.id).length === 1);
    await sleep(30);
    const replayed = peer.notifications('notifications/events/event')
      .filter((n) => n.params._meta[SUB] === second.id);
    expect(replayed.map((n) => n.params.eventId)).toEqual(['e2']);
    const active = peer.notifications('notifications/events/active')
      .find((n) => n.params._meta[SUB] === second.id);
    expect(active.params.truncated).toBe(false);
    await peer.close();
  });

  it('marks a cursor from another server run as truncated and starts from now', async () => {
    const api = scriptedApi();
    const peer = await rawPeer(on(api));
    const stream = peer.send('events/stream', { name: MENTION_EVENT, cursor: 'old-run:5' });
    await waitFor(() => peer.notifications('notifications/events/active').length === 1);
    const [active] = peer.notifications('notifications/events/active');
    expect(active.params).toMatchObject({ cursor: 'ep1:0', truncated: true, _meta: { [SUB]: stream.id } });
    await peer.close();
  });

  it('takes no subscription arguments: the poll cannot filter, so a filter would only discard', async () => {
    const api = scriptedApi();
    const peer = await rawPeer(on(api));
    const filtered = await peer.send('events/stream', { name: MENTION_EVENT, arguments: { podId: 'pod2' } }).answered;
    expect(filtered.error.code).toBe(-32602);
    const { result } = await peer.send('events/list').answered;
    for (const type of result.events) expect(type.inputSchema.properties).toEqual({});
    await peer.close();
  });

  it('holds a mention, unacked, while only a task stream is open, and delivers it when a mention stream opens', async () => {
    const api = scriptedApi([[mention('e1'), assignment('t1')]]);
    const handle = on(api);
    const peer = await rawPeer(handle);
    peer.send('events/stream', { name: TASK_EVENT });
    await waitFor(() => api.calls.some((c) => c.path === `${EVENTS_PATH}/t1/ack`));
    await waitFor(() => api.polls() >= 3);
    // The assignment went out; the mention is held, neither acked nor released.
    expect(peer.notifications('notifications/events/event').map((n) => n.params.eventId)).toEqual(['t1']);
    expect(api.calls.some((c) => c.path === `${EVENTS_PATH}/e1/ack`)).toBe(false);
    expect(api.calls.some((c) => c.path === `${EVENTS_PATH}/release`)).toBe(false);
    expect(handle.events.heldCount).toBe(1);

    const mentions = peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => api.calls.some((c) => c.path === `${EVENTS_PATH}/e1/ack`));
    const written = peer.notifications('notifications/events/event')
      .filter((n) => n.params._meta[SUB] === mentions.id);
    expect(written.map((n) => n.params.eventId)).toEqual(['e1']);
    expect(api.calls.find((c) => c.path === `${EVENTS_PATH}/e1/ack`).body.result.outcome).toBe('acknowledged');
    expect(handle.events.heldCount).toBe(0);
    await peer.close();
  });

  it('hands a held mention back when the server stops, instead of acking it', async () => {
    const api = scriptedApi([[mention('e1')]]);
    const handle = on(api);
    const peer = await rawPeer(handle);
    peer.send('events/stream', { name: TASK_EVENT });
    await waitFor(() => handle.events.heldCount === 1);
    await peer.close();
    await handle.events.done();
    const released = api.calls.find((c) => c.path === `${EVENTS_PATH}/release`);
    expect(released.body).toEqual({ events: [{ eventId: 'e1', deliveryId: 'd-e1' }] });
    expect(api.calls.some((c) => c.path.endsWith('/ack'))).toBe(false);
  });

  it('at a full hold, releases the oldest held events and keeps polling with backoff', async () => {
    // A fake kernel: claims oldest-first, a release puts a row back to pending,
    // and a claim spends an attempt; at the ceiling a release is refused and the
    // row stays claimed (the kernel's sweep retires it), as the backend does.
    const CEILING = 6;
    const rows = Array.from({ length: 60 }, (_, i) => ({ event: mention(`m${String(i).padStart(2, '0')}`), status: 'pending', attempts: 0 }));
    rows.push({ event: assignment('t1'), status: 'pending', attempts: 0 });
    const calls = [];
    // Taken when t1 is acked: the fake clock runs on after it.
    let atT1 = null;
    const requestImpl = async (config, { method, path, body }) => {
      calls.push({ method, path, body });
      if (path.endsWith('/t1/ack') && !atT1) {
        atT1 = { polls: calls.filter((c) => c.path === EVENTS_PATH).length, clock, waits: [...waits] };
      }
      if (path === EVENTS_PATH && method === 'GET') {
        const page = rows.filter((r) => r.status === 'pending').slice(0, 10);
        for (const r of page) { r.status = 'delivered'; r.attempts += 1; }
        return { events: page.map((r) => r.event) };
      }
      if (path === `${EVENTS_PATH}/release`) {
        for (const { eventId } of body.events) {
          const row = rows.find((r) => String(r.event._id) === eventId);
          if (row && row.status === 'delivered' && row.attempts < CEILING) row.status = 'pending';
        }
      }
      if (path.endsWith('/ack')) {
        const row = rows.find((r) => path.includes(`/${r.event._id}/ack`));
        if (row) row.status = 'acked';
      }
      return { success: true };
    };
    // A fake clock: every wait the hub asks for adds to it and returns at once.
    let clock = 0;
    const waits = [];
    let maxHeld = 0;
    let handle;
    const setTimer = (fn, ms) => {
      clock += ms;
      waits.push(ms);
      maxHeld = Math.max(maxHeld, handle?.events?.heldCount || 0);
      const id = setImmediate(fn);
      return { unref: () => {}, id };
    };
    const clearTimer = (t) => { if (t) clearImmediate(t.id); };
    handle = on({ requestImpl }, {
      intervalMs: 1000, busyDelayMs: 250, maxBackoffMs: 8000, setTimer, clearTimer,
    });
    const peer = await rawPeer(handle);
    peer.send('events/stream', { name: TASK_EVENT });
    const got = await waitFor(() => peer.notifications('notifications/events/event')
      .some((n) => n.params.eventId === 't1') && atT1, 5000);
    expect(got).toBeTruthy();
    const { polls } = atT1;
    const releases = calls.filter((c) => c.path === `${EVENTS_PATH}/release`);
    // The hold stays bounded: at most one page over the cap.
    expect(maxHeld).toBeLessThanOrEqual(60);
    // Everything not written went back through /events/release; no mention was acked.
    expect(releases.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.path.endsWith('/ack') && !c.path.includes('/t1/'))).toBe(false);
    // No tight loop: the waits after a full hold back off, doubling to the cap.
    expect(atT1.waits).toContain(2000);
    expect(atT1.waits).toContain(8000);
    expect(Math.max(...atT1.waits)).toBe(8000);
    expect(polls).toBeLessThan(80);
    expect(atT1.clock / polls).toBeGreaterThan(1000);
    await peer.close();
  });

  it('writes an event once when a held copy and a redelivery race under backpressure', async () => {
    const queue = [];
    const requestImpl = async (config, { method, path }) => {
      if (path === EVENTS_PATH && method === 'GET') return { events: queue.splice(0) };
      return { success: true };
    };
    const handle = on({ requestImpl });
    const peer = await rawPeer(handle, { delayMs: 40 });
    peer.send('events/stream', { name: TASK_EVENT });
    queue.push(mention('e1'));
    await waitFor(() => handle.events.heldCount === 1);
    peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => peer.notifications('notifications/events/active').length === 2);
    // While the held copy's write is in flight, the kernel's lease requeued
    // it, so the next poll hands it over again.
    queue.push(mention('e1', { deliveryId: 'd-e1-again' }));
    await waitFor(() => handle.events.heldCount === 0);
    await sleep(200);
    const writes = peer.notifications('notifications/events/event').filter((n) => n.params.eventId === 'e1');
    expect(writes).toHaveLength(1);
    await peer.close();
  });

  it('never acks an offered event without a successful stream write', async () => {
    const offered = [mention('e1'), assignment('t1'), mention('e2'), assignment('t2')];
    const api = scriptedApi([offered.slice(0, 2), [{ _id: 'h1', type: 'heartbeat' }], offered.slice(2)]);
    const handle = on(api);
    const peer = await rawPeer(handle);
    const tasks = peer.send('events/stream', { name: TASK_EVENT });
    await waitFor(() => api.polls() >= 4);
    peer.cancel(tasks.id);
    peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => api.calls.filter((c) => c.path.endsWith('/ack')).length >= 5);
    await sleep(20);
    const written = new Set(peer.notifications('notifications/events/event').map((n) => n.params.eventId));
    for (const event of offered) {
      const ack = api.calls.find((c) => c.path === `${EVENTS_PATH}/${event._id}/ack`);
      if (ack) {
        expect(written.has(event._id)).toBe(true);
        expect(ack.body.result.outcome).toBe('acknowledged');
      }
    }
    expect(['e1', 'e2', 't1', 't2'].every((id) => written.has(id))).toBe(true);
    await peer.close();
  });

  it('releases an event, never acks it, when every write to its stream fails', async () => {
    const api = scriptedApi([[mention('e1')]]);
    const handle = on(api);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const send = serverSide.send.bind(serverSide);
    serverSide.send = (message, options) => (message?.method === 'notifications/events/event'
      ? Promise.reject(new Error('EPIPE: broken pipe'))
      : send(message, options));
    await handle.connect(serverSide);
    await clientSide.start();
    clientSide.send({
      jsonrpc: '2.0', id: 1, method: 'events/stream', params: { name: MENTION_EVENT },
    });
    await waitFor(() => api.calls.some((c) => c.path === `${EVENTS_PATH}/release`));
    const released = api.calls.find((c) => c.path === `${EVENTS_PATH}/release`);
    expect(released.body).toEqual({ events: [{ eventId: 'e1', deliveryId: 'd-e1' }] });
    expect(api.calls.some((c) => c.path.endsWith('/ack'))).toBe(false);
    // The broken stream is closed, so nothing is claimed again for it.
    expect(handle.events.streamCount).toBe(0);
    await clientSide.close();
  });

  it('ends open streams with notifications/events/terminated on a 401, and refuses new ones', async () => {
    const requestImpl = async () => {
      const error = new Error('Unauthorized');
      error.status = 401;
      throw error;
    };
    const handle = createServer(cfg, {
      env: {}, events: true, eventsOptions: { ...quiet, requestImpl, epoch: 'ep1' },
    });
    const peer = await rawPeer(handle);
    const stream = peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => peer.notifications('notifications/events/terminated').length === 1);
    const [terminated] = peer.notifications('notifications/events/terminated');
    expect(terminated.params).toMatchObject({ error: { code: -32024, message: 'Forbidden' }, _meta: { [SUB]: stream.id } });
    const final = await stream.answered;
    expect(final.result).toMatchObject({ resultType: 'complete' });
    const again = await peer.send('events/stream', { name: MENTION_EVENT }).answered;
    expect(again.error.code).toBe(-32024);
    const beats = peer.notifications('notifications/events/heartbeat').length;
    await sleep(30);
    expect(peer.notifications('notifications/events/heartbeat').length).toBe(beats);
    await peer.close();
  });

  it('gives every written event its own cursor when a held write and a live write overlap', async () => {
    const api = queuedApi();
    const handle = on({ requestImpl: api.requestImpl });
    const peer = await rawPeer(handle, { delayMs: 40 });
    peer.send('events/stream', { name: TASK_EVENT });
    api.queue.push(mention('e1'));
    await waitFor(() => handle.events.heldCount === 1);
    const mentions = peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => peer.notifications('notifications/events/active').length === 2);
    // The held e1 is being written to the new stream; a fresh e2 arrives now.
    api.queue.push(mention('e2'));
    await waitFor(() => peer.seen.filter((m) => isEvent(m, mentions.id)).length === 2);
    const cursors = peer.seen.filter((m) => isEvent(m, mentions.id)).map((m) => m.params.cursor);
    expect(new Set(cursors).size).toBe(2);
    // Delivery order matches cursor order.
    const positions = cursors.map((c) => Number(c.split(':')[1]));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    await peer.close();
  });

  it('does not count a write to a stream the client cancelled as delivered', async () => {
    const api = queuedApi();
    const handle = on({ requestImpl: api.requestImpl });
    const gate = deferred();
    let pending = false;
    let first;
    const peer = await rawPeer(handle, {
      intercept: (message, pass) => {
        if (first && isEvent(message, first.id, 'e1')) {
          pending = true;
          return gate.promise.then(() => { throw new Error('EPIPE: broken pipe'); });
        }
        return pass();
      },
    });
    first = peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => handle.events.streamCount === 1);
    const second = peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => handle.events.streamCount === 2);
    api.queue.push(mention('e1'));
    await waitFor(() => pending);
    // The client cancels the second stream while the first stream's write hangs.
    peer.cancel(second.id);
    await waitFor(() => handle.events.streamCount === 1);
    gate.resolve();
    expect(await waitFor(() => api.calls.some((c) => c.path === `${EVENTS_PATH}/release`))).toBe(true);
    expect(api.calls.find((c) => c.path === `${EVENTS_PATH}/release`).body)
      .toEqual({ events: [{ eventId: 'e1', deliveryId: 'd-e1' }] });
    expect(api.calls.some((c) => c.path.endsWith('/ack'))).toBe(false);
    await peer.close();
  });

  it('a resuming stream receives an event committed during its replay', async () => {
    const api = queuedApi();
    const handle = on({ requestImpl: api.requestImpl });
    const gate = deferred();
    let replaying = false;
    let resumed;
    const peer = await rawPeer(handle, {
      intercept: (message, pass) => {
        if (resumed && isEvent(message, resumed.id, 'e1') && !replaying) {
          replaying = true;
          return gate.promise.then(pass);
        }
        return pass();
      },
    });
    const live = peer.send('events/stream', { name: MENTION_EVENT });
    api.queue.push(mention('e1'));
    await waitFor(() => peer.seen.some((m) => isEvent(m, live.id, 'e1')));
    resumed = peer.send('events/stream', { name: MENTION_EVENT, cursor: 'ep1:0' });
    await waitFor(() => replaying);
    // e2 is committed while the replay of e1 to the resuming stream is held open.
    api.queue.push(mention('e2'));
    await sleep(40);
    gate.resolve();
    await waitFor(() => peer.seen.some((m) => isEvent(m, resumed.id, 'e2')), 1000);
    const got = peer.seen.filter((m) => isEvent(m, resumed.id)).map((m) => m.params.eventId);
    expect(got).toEqual(['e1', 'e2']);
    expect(peer.seen.some((m) => isEvent(m, live.id, 'e2'))).toBe(true);
    await peer.close();
  });

  it('never sends a cursor past an event the stream has not received, even while its replay stalls', async () => {
    const api = queuedApi();
    const handle = on({ requestImpl: api.requestImpl }, { minHeartbeatMs: 10 });
    const gate = deferred();
    let stalled = false;
    let resumed;
    const peer = await rawPeer(handle, {
      intercept: (message, pass) => {
        if (resumed && isEvent(message, resumed.id, 'e2') && !stalled) {
          stalled = true;
          return gate.promise.then(pass);
        }
        return pass();
      },
    });
    const live = peer.send('events/stream', { name: MENTION_EVENT });
    api.queue.push(mention('e1'), mention('e2'));
    await waitFor(() => peer.seen.filter((m) => isEvent(m, live.id)).length === 2);
    resumed = peer.send('events/stream', { name: MENTION_EVENT, cursor: 'ep1:0', heartbeatMs: 10 });
    await waitFor(() => stalled);
    // The replay of e2 stalls across several heartbeat intervals.
    await waitFor(() => peer.notifications('notifications/events/heartbeat')
      .filter((n) => n.params._meta[SUB] === resumed.id).length >= 2, 500);
    gate.resolve();
    await waitFor(() => peer.seen.some((m) => isEvent(m, resumed.id, 'e2')));
    const position = (cursor) => Number(cursor.split(':')[1]);
    let received = 0;
    const mine = peer.seen.filter((m) => m.method?.startsWith('notifications/events/')
      && m.params?._meta?.[SUB] === resumed.id);
    expect(mine.some((m) => m.method === 'notifications/events/heartbeat')).toBe(true);
    for (const m of mine) {
      if (m.method === 'notifications/events/event') {
        received = Math.max(received, position(m.params.cursor));
      } else if (m.params.cursor) {
        // active and heartbeat: never ahead of what this stream received.
        expect(position(m.params.cursor)).toBeLessThanOrEqual(received);
      }
    }
    await peer.close();
  });

  it('writes an event once when a drain of the hold and a redelivery start together', async () => {
    // The drain (a mention stream opening) and the redelivery (a poll
    // answering) start a few microtasks apart; sweep the gap so one lands
    // inside the other's check-then-write window.
    for (let gap = 0; gap <= 16; gap += 1) {
      const answer = deferred();
      let gated = false;
      let queue = [mention('e1')];
      const calls = [];
      const requestImpl = async (config, { method, path }) => {
        calls.push({ method, path });
        if (path === EVENTS_PATH && method === 'GET') {
          if (gated) {
            gated = false;
            await answer.promise;
            return { events: [mention('e1', { deliveryId: 'd-e1-again' })] };
          }
          return { events: queue.splice(0) };
        }
        return { success: true };
      };
      const handle = on({ requestImpl });
      const opening = deferred();
      let m;
      // eslint-disable-next-line no-await-in-loop
      const peer = await rawPeer(handle, {
        intercept: (message, pass) => (m && message?.method === 'notifications/events/active'
          && message.params._meta[SUB] === m.id ? opening.promise.then(pass) : pass()),
      });
      peer.send('events/stream', { name: TASK_EVENT });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => handle.events.heldCount === 1);
      gated = true;
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => !gated);
      m = peer.send('events/stream', { name: MENTION_EVENT });
      // eslint-disable-next-line no-await-in-loop
      await sleep(5);
      opening.resolve();
      // eslint-disable-next-line no-await-in-loop
      for (let i = 0; i < gap; i += 1) await Promise.resolve();
      answer.resolve();
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => calls.filter((c) => c.path.endsWith('/e1/ack')).length >= 1);
      // eslint-disable-next-line no-await-in-loop
      await sleep(20);
      expect(peer.seen.filter((msg) => isEvent(msg, m.id, 'e1')).length).toBe(1);
      queue = [];
      // eslint-disable-next-line no-await-in-loop
      await peer.close();
    }
  });

  it('hands a held event back at once when every write to the stream that opens for it fails', async () => {
    const api = queuedApi();
    const handle = on({ requestImpl: api.requestImpl });
    const peer = await rawPeer(handle, {
      intercept: (message, pass) => (isEvent(message, undefined, 'e1')
        ? Promise.reject(new Error('EPIPE: broken pipe'))
        : pass()),
    });
    peer.send('events/stream', { name: TASK_EVENT });
    api.queue.push(mention('e1'));
    await waitFor(() => handle.events.heldCount === 1);
    peer.send('events/stream', { name: MENTION_EVENT });
    // Still running: the hand-back comes from the failed fan-out, not from stop().
    expect(await waitFor(() => api.calls.some((c) => c.path === `${EVENTS_PATH}/release`), 1000)).toBe(true);
    expect(api.calls.find((c) => c.path === `${EVENTS_PATH}/release`).body)
      .toEqual({ events: [{ eventId: 'e1', deliveryId: 'd-e1' }] });
    expect(handle.events.heldCount).toBe(0);
    expect(api.calls.some((c) => c.path.endsWith('/ack'))).toBe(false);
    await peer.close();
  });

  it('acks a held event only after its write to the new stream completes', async () => {
    const api = queuedApi();
    const handle = on({ requestImpl: api.requestImpl });
    const gate = deferred();
    let pending = false;
    const peer = await rawPeer(handle, {
      intercept: (message, pass) => {
        if (isEvent(message, undefined, 'e1')) {
          pending = true;
          return gate.promise.then(pass);
        }
        return pass();
      },
    });
    peer.send('events/stream', { name: TASK_EVENT });
    api.queue.push(mention('e1'));
    await waitFor(() => handle.events.heldCount === 1);
    peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => pending);
    await sleep(30);
    expect(api.calls.some((c) => c.path === `${EVENTS_PATH}/e1/ack`)).toBe(false);
    gate.resolve();
    expect(await waitFor(() => api.calls.some((c) => c.path === `${EVENTS_PATH}/e1/ack`))).toBe(true);
    await peer.close();
  });

  it('sends a 401 termination to a stream that was still opening when the token was refused', async () => {
    const gate = deferred();
    let polled = false;
    const requestImpl = async (_config, { method, path }) => {
      if (path === EVENTS_PATH && method === 'GET') {
        polled = true;
        await gate.promise;
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
      }
      return { success: true };
    };
    const handle = on({ requestImpl });
    const opening = deferred();
    const terminating = deferred();
    let second;
    let holdTermination = true;
    const peer = await rawPeer(handle, {
      intercept: (message, pass) => {
        if (second && message?.method === 'notifications/events/active'
          && message.params._meta[SUB] === second.id) {
          return opening.promise.then(pass);
        }
        if (holdTermination && message?.method === 'notifications/events/terminated') {
          // terminateAll is still sending to the first stream when the second registers.
          holdTermination = false;
          return terminating.promise.then(pass);
        }
        return pass();
      },
    });
    const first = peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => polled);
    second = peer.send('events/stream', { name: MENTION_EVENT });
    await sleep(10);
    gate.resolve();
    await sleep(10);
    opening.resolve();
    await sleep(20);
    terminating.resolve();
    expect(await waitFor(() => peer.notifications('notifications/events/terminated').length === 2, 1000)).toBe(true);
    const ids = peer.notifications('notifications/events/terminated').map((n) => n.params._meta[SUB]);
    expect(ids.sort()).toEqual([first.id, second.id].sort());
    expect(handle.events.streamCount).toBe(0);
    await peer.close();
  });

  it('does not rearm the heartbeat after the stream closes', async () => {
    const handle = on(scriptedApi(), { minHeartbeatMs: 10 });
    const beat = deferred();
    let pending = false;
    const peer = await rawPeer(handle, {
      intercept: (message, pass) => {
        if (message?.method === 'notifications/events/heartbeat' && !pending) {
          pending = true;
          return beat.promise.then(pass);
        }
        return pass();
      },
    });
    const HEARTBEAT = 37;
    const stream = peer.send('events/stream', { name: MENTION_EVENT, heartbeatMs: HEARTBEAT });
    await waitFor(() => pending);
    peer.cancel(stream.id);
    await waitFor(() => handle.events.streamCount === 0);
    const spy = jest.spyOn(global, 'setTimeout');
    try {
      beat.resolve();
      await sleep(20);
      expect(spy.mock.calls.filter(([, ms]) => ms === HEARTBEAT)).toHaveLength(0);
    } finally {
      spy.mockRestore();
      await peer.close();
    }
  });

  it('waits out Retry-After on a 429 before polling again', async () => {
    const at = [];
    let first = true;
    const requestImpl = async (_config, { path, method }) => {
      if (path === EVENTS_PATH && method === 'GET') {
        at.push(Date.now());
        if (first) {
          first = false;
          const error = new Error('Too Many Requests');
          error.status = 429;
          error.retryAfterMs = 120;
          throw error;
        }
      }
      return { events: [] };
    };
    const handle = createServer(cfg, {
      env: {}, events: true, eventsOptions: { ...quiet, requestImpl, epoch: 'ep1' },
    });
    const peer = await rawPeer(handle);
    peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => at.length >= 2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(110);
    await peer.close();
  });

  it('forgets a cancelled 2026-07-28 request, so a reused id is answered as legacy', async () => {
    const api = scriptedApi();
    const peer = await rawPeer(on(api));
    const stream = peer.send('events/stream', { name: MENTION_EVENT }, 77);
    await waitFor(() => peer.notifications('notifications/events/active').length === 1);
    peer.cancel(stream.id);
    await sleep(10);
    await peer.raw({ jsonrpc: '2.0', id: 77, method: 'tools/list', params: {} });
    await waitFor(() => peer.seen.some((m) => m.id === 77 && m.result));
    const reply = peer.seen.find((m) => m.id === 77 && m.result);
    expect(reply.result.resultType).toBeUndefined();
    await peer.close();
  });

  it('sends heartbeats carrying the cursor while nothing happens', async () => {
    const api = scriptedApi();
    const peer = await rawPeer(on(api, { minHeartbeatMs: 10 }));
    peer.send('events/stream', { name: MENTION_EVENT, heartbeatMs: 10 });
    await waitFor(() => peer.notifications('notifications/events/heartbeat').length >= 2);
    const [beat] = peer.notifications('notifications/events/heartbeat');
    expect(beat.params.cursor).toBe('ep1:0');
    await peer.close();
  });

  it('stops polling when the transport closes and hands back what it could not deliver', async () => {
    let release;
    const api = scriptedApi();
    const requestImpl = async (config, opts) => {
      if (opts.path === EVENTS_PATH && opts.method === 'GET' && api.polls() === 0) {
        api.calls.push({ ...opts, token: config.token });
        await new Promise((r) => { release = r; });
        return { events: [mention('e1')] };
      }
      return api.requestImpl(config, opts);
    };
    const handle = createServer(cfg, {
      env: {}, events: true, eventsOptions: { ...quiet, requestImpl, epoch: 'ep1' },
    });
    const peer = await rawPeer(handle);
    peer.send('events/stream', { name: MENTION_EVENT });
    await waitFor(() => typeof release === 'function');
    await peer.close();
    release();
    await handle.events.done();
    const released = api.calls.find((c) => c.path === `${EVENTS_PATH}/release`);
    expect(released.body).toEqual({ events: [{ eventId: 'e1', deliveryId: 'd-e1' }] });
    expect(api.calls.some((c) => c.path.endsWith('/ack'))).toBe(false);
    const polls = api.polls();
    await sleep(30);
    expect(api.polls()).toBe(polls);
  });

  it('never puts the runtime token in a payload, a notification or a log line', async () => {
    const lines = [];
    const api = scriptedApi([[mention('e1', { rawContent: 'hi' }), assignment('t1'), { _id: 'x', type: 'heartbeat' }]]);
    const handle = createServer(cfg, {
      env: {}, events: true, eventsOptions: { ...quiet, requestImpl: api.requestImpl, log: (l) => lines.push(l) },
    });
    const peer = await rawPeer(handle);
    peer.send('events/list');
    peer.send('events/stream', { name: MENTION_EVENT });
    peer.send('events/stream', { name: TASK_EVENT });
    peer.send('events/stream', { name: 'nope' });
    await waitFor(() => peer.notifications('notifications/events/event').length === 2);
    await sleep(20);
    expect(JSON.stringify(peer.seen)).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.length).toBeGreaterThan(0);
    await peer.close();
  });
});

describe('stopOnSignals', () => {
  const fakeProcess = () => {
    const proc = new EventEmitter();
    proc.exitCode = null;
    proc.exit = (code) => { proc.exitCode = code; };
    return proc;
  };

  it('on SIGTERM, stops the hub and hands back held events before exiting', async () => {
    const api = scriptedApi([[mention('e1')]]);
    const handle = createServer(cfg, {
      env: {}, events: true, eventsOptions: { ...quiet, requestImpl: api.requestImpl, epoch: 'ep1' },
    });
    const peer = await rawPeer(handle);
    peer.send('events/stream', { name: TASK_EVENT });
    await waitFor(() => handle.events.heldCount === 1);
    const proc = fakeProcess();
    stopOnSignals(handle.events, { proc, timeoutMs: 1000 });
    proc.emit('SIGTERM');
    await waitFor(() => proc.exitCode !== null);
    expect(proc.exitCode).toBe(143);
    const released = api.calls.find((c) => c.path === `${EVENTS_PATH}/release`);
    expect(released.body).toEqual({ events: [{ eventId: 'e1', deliveryId: 'd-e1' }] });
    expect(api.calls.some((c) => c.path.endsWith('/ack'))).toBe(false);
    await peer.close();
  });

  it('when the host closes stdin, stops the hub and hands back held events', async () => {
    const api = scriptedApi([[mention('e1')]]);
    const handle = createServer(cfg, {
      env: {}, events: true, eventsOptions: { ...quiet, requestImpl: api.requestImpl, epoch: 'ep1' },
    });
    const peer = await rawPeer(handle);
    peer.send('events/stream', { name: TASK_EVENT });
    await waitFor(() => handle.events.heldCount === 1);
    const proc = fakeProcess();
    proc.stdin = new EventEmitter();
    stopOnSignals(handle.events, { proc, timeoutMs: 1000 });
    proc.stdin.emit('end');
    await waitFor(() => proc.exitCode !== null);
    expect(proc.exitCode).toBe(0);
    const released = api.calls.find((c) => c.path === `${EVENTS_PATH}/release`);
    expect(released.body).toEqual({ events: [{ eventId: 'e1', deliveryId: 'd-e1' }] });
    expect(api.calls.some((c) => c.path.endsWith('/ack'))).toBe(false);
    await peer.close();
  });

  it('exits anyway when the hand-back does not finish in time', async () => {
    const proc = fakeProcess();
    const hub = { stop: () => {}, done: () => new Promise(() => {}) };
    stopOnSignals(hub, { proc, timeoutMs: 20 });
    proc.emit('SIGINT');
    await waitFor(() => proc.exitCode !== null);
    expect(proc.exitCode).toBe(130);
  });
});

describe('occurrenceFor', () => {
  it('maps a thread mention with its thread root and cuts a long excerpt', () => {
    const long = 'x'.repeat(600);
    const occ = occurrenceFor({
      ...mention('e1', { threadRootId: 9, rawContent: long }), type: 'thread.mention',
    });
    expect(occ.name).toBe(MENTION_EVENT);
    expect(occ.data.threadRootId).toBe('9');
    expect(occ.data.eventType).toBe('thread.mention');
    expect(occ.data.excerpt.length).toBeLessThanOrEqual(280);
  });

  it('bounds the sender name', () => {
    const occ = occurrenceFor(mention('e1', { username: 'n'.repeat(500) }));
    expect(occ.data.senderName).toHaveLength(80);
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  it('offers a board wake only when the agent is the assignee', () => {
    expect(occurrenceFor(assignment('t1')).name).toBe(TASK_EVENT);
    const claimant = assignment('t2');
    claimant.payload.wakeReason = 'claimant';
    expect(occurrenceFor(claimant)).toBeNull();
    const digest = { ...assignment('t3'), deliveryMode: 'digest' };
    expect(occurrenceFor(digest)).toBeNull();
  });
});
