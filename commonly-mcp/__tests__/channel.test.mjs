/**
 * Channel mode (Claude Code channels, research preview): the poll loop that
 * pushes a Commonly @mention into a person's running session.
 *
 * The loop takes its HTTP call and its `notify` as arguments, so these drive it
 * with a scripted API and record what it pushed and what it acked.
 */

import { HttpError } from '../src/client.js';
import {
  answerRootOfWake,
  channelEventFor,
  channelRequested,
  parseAllowlist,
  startChannel,
} from '../src/channel.js';

const cfg = { baseUrl: 'https://x.example', token: 'cm_agent_t' };
const OWNER = 'a'.repeat(24);
const STRANGER = 'b'.repeat(24);
const AGENT = 'c'.repeat(24);

const mention = (over = {}, payload = {}) => ({
  _id: over._id || 'e1',
  type: 'chat.mention',
  podId: 'p1',
  ...over,
  payload: {
    messageId: '501',
    userId: OWNER,
    senderIsHuman: true,
    content: 'hey @agent, look at this',
    deliveryId: 'd1',
    ...payload,
  },
});

/**
 * A scripted API. `pages` is what successive GET /events return (an Error is
 * thrown); after the last page every GET returns no events. `owner` is what
 * GET /installations names.
 */
const fakeApi = ({ pages = [], owner = OWNER, installationsError = null } = {}) => {
  const calls = [];
  let page = 0;
  const requestImpl = async (_config, { method, path, query, body }) => {
    calls.push({ method, path, query, body });
    if (path === '/api/agents/runtime/installations') {
      if (installationsError) throw installationsError;
      return { installations: [], ownerUserId: owner };
    }
    if (path === '/api/agents/runtime/events') {
      const next = pages[page];
      page += 1;
      if (next instanceof Error) throw next;
      return { events: next || [] };
    }
    if (path.endsWith('/ack')) return { success: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { calls, requestImpl, acks: () => calls.filter((c) => c.path.endsWith('/ack')) };
};

const waitFor = async (check, ms = 2000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => { setTimeout(r, 5); });
  }
  return false;
};

/** Run the loop until `until()` holds, then stop it and return what it did. */
const drive = async ({ api, env = {}, until }) => {
  const pushed = [];
  const logs = [];
  const channel = startChannel({
    config: cfg,
    env,
    notify: async (params) => { pushed.push(params); },
    log: (line) => logs.push(line),
    requestImpl: api.requestImpl,
    intervalMs: 5,
    busyDelayMs: 1,
  });
  await waitFor(() => until({ pushed, logs }));
  channel.stop();
  await channel.done;
  return { pushed, logs };
};

describe('opt-in', () => {
  it('is off unless asked for by env or argument', () => {
    expect(channelRequested({ env: {}, argv: [] })).toBe(false);
    expect(channelRequested({ env: { COMMONLY_MCP_CHANNEL: '0' }, argv: [] })).toBe(false);
    expect(channelRequested({ env: { COMMONLY_MCP_CHANNEL: '1' }, argv: [] })).toBe(true);
    expect(channelRequested({ env: { COMMONLY_MCP_CHANNEL: 'true' }, argv: [] })).toBe(true);
    expect(channelRequested({ env: {}, argv: ['--channel'] })).toBe(true);
  });

  it('reads the allowlist as comma-separated ids', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist(` ${OWNER}, ,${STRANGER} `)).toEqual([OWNER, STRANGER]);
  });
});

describe('the thread to answer in (mirrors the kernel answerRootOfWake)', () => {
  it('a top-level chat.mention is answered in its own thread', () => {
    expect(answerRootOfWake(mention())).toBe(501);
  });
  it('an in-thread wake is answered in its root', () => {
    expect(answerRootOfWake(mention({}, { threadRootId: 42 }))).toBe(42);
    expect(answerRootOfWake(mention({ type: 'thread.mention' }, { threadRootId: '42' }))).toBe(42);
  });
  it('a coalesced row, a non-numeric id, and a post comment name no thread', () => {
    expect(answerRootOfWake(mention({}, { coalesced: [{ messageId: '502', userId: OWNER }] }))).toBeNull();
    expect(answerRootOfWake(mention({}, { messageId: 'abc' }))).toBeNull();
    expect(answerRootOfWake(mention({ type: 'thread.mention' }))).toBeNull();
  });
  it('a coalesced row says in its content that it names no thread', () => {
    const { content, meta } = channelEventFor(mention({}, { coalesced: [{ messageId: '502', userId: OWNER }] }));
    expect(meta.thread_root_id).toBe('');
    expect(content).toMatch(/no single thread/);
  });
  it('falls back to a short line when the wake has no text', () => {
    const { content } = channelEventFor(mention({}, { content: undefined }));
    expect(content).toMatch(/mentioned/i);
  });
});

describe('poll loop', () => {
  it('pushes an allowed top-level mention with underscore-only meta, then acks it', async () => {
    const api = fakeApi({ pages: [[mention()]] });
    const { pushed } = await drive({ api, until: () => api.acks().length >= 1 });

    expect(pushed).toHaveLength(1);
    expect(pushed[0].content).toBe('hey @agent, look at this');
    expect(pushed[0].meta).toEqual({
      pod_id: 'p1',
      message_id: '501',
      thread_root_id: '501',
      sender_id: OWNER,
      event_id: 'e1',
      event_type: 'chat.mention',
    });
    for (const key of Object.keys(pushed[0].meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    for (const value of Object.values(pushed[0].meta)) expect(typeof value).toBe('string');

    const [ack] = api.acks();
    expect(ack.path).toBe('/api/agents/runtime/events/e1/ack');
    expect(ack.body).toEqual({
      result: { outcome: 'acknowledged', reason: 'delivered to the session' },
      deliveryId: 'd1',
    });
  });

  it('gives an in-thread mention its root as the thread', async () => {
    const api = fakeApi({ pages: [[mention({}, { threadRootId: 77 })]] });
    const { pushed } = await drive({ api, until: () => api.acks().length >= 1 });
    expect(pushed[0].meta.thread_root_id).toBe('77');
  });

  it('gives a coalesced row no thread', async () => {
    const api = fakeApi({ pages: [[mention({}, { coalesced: [{ messageId: '502', userId: OWNER }] })]] });
    const { pushed } = await drive({ api, until: () => api.acks().length >= 1 });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].meta.thread_root_id).toBe('');
  });

  it('acks a sender who is not allowed, and pushes nothing', async () => {
    const api = fakeApi({ pages: [[mention({}, { userId: STRANGER })]] });
    const { pushed, logs } = await drive({ api, until: () => api.acks().length >= 1 });
    expect(pushed).toHaveLength(0);
    expect(api.acks()[0].body.result.outcome).toBe('no_action');
    expect(logs.join('\n')).toMatch(/not allowed/);
  });

  it('acks a coalesced row that carries another author, and pushes nothing', async () => {
    const api = fakeApi({ pages: [[mention({}, { coalesced: [{ messageId: '502', userId: STRANGER }] })]] });
    const { pushed } = await drive({ api, until: () => api.acks().length >= 1 });
    expect(pushed).toHaveLength(0);
  });

  it('acks an agent-authored mention without a push, unless that agent is on the allowlist', async () => {
    const fromAgent = mention({}, { userId: AGENT, senderIsHuman: false });

    const ownerOnly = fakeApi({ pages: [[fromAgent]], owner: AGENT });
    const refused = await drive({ api: ownerOnly, until: () => ownerOnly.acks().length >= 1 });
    expect(refused.pushed).toHaveLength(0);

    const listed = fakeApi({ pages: [[fromAgent]] });
    const allowed = await drive({
      api: listed,
      env: { COMMONLY_MCP_CHANNEL_ALLOW: `${OWNER},${AGENT}` },
      until: () => listed.acks().length >= 1,
    });
    expect(allowed.pushed).toHaveLength(1);
    expect(allowed.pushed[0].meta.sender_id).toBe(AGENT);
  });

  it('acks a heartbeat and other event types without a push', async () => {
    const api = fakeApi({
      pages: [[
        { _id: 'h1', type: 'heartbeat', podId: 'p1', payload: { deliveryId: 'dh' } },
        { _id: 'm1', type: 'message.posted', podId: 'p1', payload: { userId: OWNER, content: 'x' } },
      ]],
    });
    const { pushed } = await drive({ api, until: () => api.acks().length >= 2 });
    expect(pushed).toHaveLength(0);
    expect(api.acks().map((a) => a.path)).toEqual([
      '/api/agents/runtime/events/h1/ack',
      '/api/agents/runtime/events/m1/ack',
    ]);
  });

  it('with an allowlist set, does not ask who the owner is', async () => {
    const api = fakeApi({ pages: [[mention()]] });
    await drive({ api, env: { COMMONLY_MCP_CHANNEL_ALLOW: OWNER }, until: () => api.acks().length >= 1 });
    expect(api.calls.some((c) => c.path === '/api/agents/runtime/installations')).toBe(false);
  });

  it('with no owner and no allowlist, pushes nothing, claims nothing, and says so once', async () => {
    const api = fakeApi({ pages: [[mention()]], owner: null });
    const pushed = [];
    const logs = [];
    const channel = startChannel({
      config: cfg,
      env: {},
      notify: async (p) => { pushed.push(p); },
      log: (line) => logs.push(line),
      requestImpl: api.requestImpl,
      intervalMs: 5,
    });
    await channel.done;
    expect(pushed).toHaveLength(0);
    expect(api.calls.some((c) => c.path === '/api/agents/runtime/events')).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/COMMONLY_MCP_CHANNEL_ALLOW/);
  });

  it('stops on a 401, logging once', async () => {
    const api = fakeApi({ pages: [new HttpError(401, { message: 'Invalid token' }, 'Invalid token')] });
    const logs = [];
    const channel = startChannel({
      config: cfg,
      env: {},
      notify: async () => {},
      log: (line) => logs.push(line),
      requestImpl: api.requestImpl,
      intervalMs: 5,
    });
    await channel.done;
    expect(api.calls.filter((c) => c.path === '/api/agents/runtime/events')).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/401/);
  });

  it('backs off on a 429 or 5xx and keeps going', async () => {
    const api = fakeApi({
      pages: [
        new HttpError(429, { message: 'slow down' }, 'slow down'),
        new HttpError(503, { message: 'unavailable' }, 'unavailable'),
        [mention()],
      ],
    });
    const { pushed } = await drive({ api, until: () => api.acks().length >= 1 });
    expect(pushed).toHaveLength(1);
  });

  it('does not ack an event it could not push, and stops', async () => {
    const api = fakeApi({ pages: [[mention()]] });
    const channel = startChannel({
      config: cfg,
      env: {},
      notify: async () => { throw new Error('Not connected'); },
      log: () => {},
      requestImpl: api.requestImpl,
      intervalMs: 5,
    });
    await channel.done;
    expect(api.acks()).toHaveLength(0);
  });

  it('stop() ends the loop and nothing polls after it', async () => {
    const api = fakeApi();
    const channel = startChannel({
      config: cfg, env: {}, notify: async () => {}, log: () => {}, requestImpl: api.requestImpl, intervalMs: 5,
    });
    await waitFor(() => api.calls.filter((c) => c.path === '/api/agents/runtime/events').length >= 2);
    channel.stop();
    await channel.done;
    const count = api.calls.length;
    await new Promise((r) => { setTimeout(r, 30); });
    expect(api.calls.length).toBe(count);
  });
});

describe('the ready gate (claim nothing before the client initializes)', () => {
  it('never polls when ready resolves false (transport closed before init)', async () => {
    const api = fakeApi({ pages: [[mention()]] });
    const channel = startChannel({
      config: cfg, env: {}, ready: Promise.resolve(false),
      notify: async () => {}, log: () => {}, requestImpl: api.requestImpl, intervalMs: 5,
    });
    await channel.done;
    expect(api.calls).toHaveLength(0);
  });

  it('waits for ready, then polls once it resolves true', async () => {
    const api = fakeApi({ pages: [[mention()]] });
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    const channel = startChannel({
      config: cfg, env: {}, ready,
      notify: async () => {}, log: () => {}, requestImpl: api.requestImpl, intervalMs: 5, busyDelayMs: 1,
    });
    await new Promise((r) => { setTimeout(r, 20); });
    expect(api.calls).toHaveLength(0);
    markReady(true);
    await waitFor(() => api.acks().length >= 1);
    channel.stop();
    await channel.done;
    expect(api.acks().length).toBeGreaterThanOrEqual(1);
  });
});
