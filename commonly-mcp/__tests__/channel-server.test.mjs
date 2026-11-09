/**
 * The server with channel mode off and on, driven over the SDK's in-memory
 * transport: what it declares at initialize, that a mention reaches the client
 * as `notifications/claude/channel`, and that closing the transport stops the
 * poll loop.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const cfg = { baseUrl: 'https://x.example', token: 'cm_agent_t' };
const OWNER = 'a'.repeat(24);

const waitFor = async (check, ms = 2000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => { setTimeout(r, 5); });
  }
  return false;
};

const scriptedApi = (pages = []) => {
  const calls = [];
  let page = 0;
  const requestImpl = async (_config, { method, path, body }) => {
    calls.push({ method, path, body });
    if (path === '/api/agents/runtime/installations') return { installations: [], ownerUserId: OWNER };
    if (path === '/api/agents/runtime/events') {
      const next = pages[page];
      page += 1;
      return { events: next || [] };
    }
    return { success: true };
  };
  return { calls, requestImpl };
};

const connect = async (handle) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  const received = [];
  client.fallbackNotificationHandler = async ({ method, params }) => { received.push({ method, params }); };
  await handle.connect(serverSide);
  await client.connect(clientSide);
  return { client, received };
};

describe('channel mode off', () => {
  it('declares tools only, sets no instructions, and never polls', async () => {
    const api = scriptedApi();
    const handle = createServer(cfg, { channel: false, channelOptions: { requestImpl: api.requestImpl, intervalMs: 5 } });
    const { client } = await connect(handle);

    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    expect(client.getInstructions()).toBeUndefined();
    await new Promise((r) => { setTimeout(r, 30); });
    expect(api.calls).toHaveLength(0);
    expect(handle.channel).toBeNull();
    await client.close();
  });
});

describe('channel mode on', () => {
  it('declares the channel capability (not permission relay) and sets instructions', async () => {
    const api = scriptedApi();
    const handle = createServer(cfg, {
      channel: true, env: {}, channelOptions: { requestImpl: api.requestImpl, intervalMs: 5, log: () => {} },
    });
    const { client } = await connect(handle);

    const caps = client.getServerCapabilities();
    expect(caps.tools).toEqual({});
    expect(caps.experimental).toEqual({ 'claude/channel': {} });
    const instructions = client.getInstructions();
    expect(instructions).toMatch(/commonly_post_message/);
    for (const key of ['pod_id', 'message_id', 'thread_root_id', 'sender_id', 'event_id', 'event_type']) {
      expect(instructions).toContain(key);
    }
    await client.close();
    await handle.channel.done;
  });

  it('pushes a mention to the client as notifications/claude/channel, then acks', async () => {
    const api = scriptedApi([[{
      _id: 'e9', type: 'chat.mention', podId: 'p1',
      payload: { messageId: '12', userId: OWNER, senderIsHuman: true, content: 'ping' },
    }]]);
    const handle = createServer(cfg, {
      channel: true, env: {}, channelOptions: { requestImpl: api.requestImpl, intervalMs: 5, log: () => {} },
    });
    const { client, received } = await connect(handle);

    await waitFor(() => api.calls.some((c) => c.path.endsWith('/ack')));
    expect(received).toEqual([{
      method: 'notifications/claude/channel',
      params: {
        content: 'ping',
        meta: {
          pod_id: 'p1', message_id: '12', thread_root_id: '12', sender_id: OWNER, event_id: 'e9', event_type: 'chat.mention',
        },
      },
    }]);
    await client.close();
    await handle.channel.done;
  });

  it('stops polling when the transport closes', async () => {
    const api = scriptedApi();
    const handle = createServer(cfg, {
      channel: true, env: {}, channelOptions: { requestImpl: api.requestImpl, intervalMs: 5, log: () => {} },
    });
    const { client } = await connect(handle);
    await waitFor(() => api.calls.filter((c) => c.path === '/api/agents/runtime/events').length >= 2);

    await client.close();
    await handle.channel.done;
    const count = api.calls.length;
    await new Promise((r) => { setTimeout(r, 30); });
    expect(api.calls.length).toBe(count);
  });

  it('never polls when the transport closes before the client initializes', async () => {
    const api = scriptedApi([[{
      _id: 'e9', type: 'chat.mention', podId: 'p1',
      payload: { messageId: '12', userId: OWNER, senderIsHuman: true, content: 'ping' },
    }]]);
    const handle = createServer(cfg, {
      channel: true, env: {}, channelOptions: { requestImpl: api.requestImpl, intervalMs: 5, log: () => {} },
    });
    const [, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.connect(serverSide);
    // Close before any client initialize: the ready gate resolves false, so the
    // loop ends without a single claim even though an event is waiting.
    await serverSide.close();
    if (handle.channel) await handle.channel.done;
    expect(api.calls).toHaveLength(0);
  });
});
