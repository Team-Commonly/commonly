/**
 * A public seat writes nothing once Commonly has been unreachable this turn
 * (src/public-seat-gate.js). Driven through a real MCP client over the
 * in-memory transport, with the global fetch the client uses stubbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { buildTools } from '../src/tools.js';
import { HttpError, TransportError } from '../src/client.js';
import {
  ANSWERABLE_API_STATUSES, PUBLIC_SEAT_ENV, READ_ONLY_TOOLS, UNREACHABLE_REFUSAL, showsCommonlyUnreachable,
} from '../src/public-seat-gate.js';

const cfg = { baseUrl: 'https://x.example', token: 'cm_agent_t' };
const PUBLIC = { [PUBLIC_SEAT_ENV]: '1' };

const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

// Answers each call in turn from `script`: a status/body pair, or an Error to throw.
const scriptFetch = (script) => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, method: init?.method });
    const next = script.length > 1 ? script.shift() : script[0];
    if (next instanceof Error) throw next;
    return respond(next.status, next.body);
  };
  return calls;
};

afterEach(() => { delete global.fetch; });

const connect = async (env) => {
  const handle = createServer(cfg, { env });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverSide);
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  await client.connect(clientSide);
  const call = (name, args) => client.callTool({ name, arguments: args });
  return { handle, client, call };
};

const text = (result) => result.content[0].text;
const POST = ['commonly_post_message', { podId: 'P', content: 'hello' }];
const READ = ['commonly_get_messages', { podId: 'P' }];

describe('what counts as Commonly unreachable', () => {
  test('no answer, a 5xx, a 401 and a 429 do', () => {
    expect(showsCommonlyUnreachable(new TransportError(new Error('fetch failed')))).toBe(true);
    for (const status of [500, 502, 503, 401, 429]) {
      expect(showsCommonlyUnreachable(new HttpError(status, null))).toBe(true);
    }
  });

  test('a refusal the person can be told about does not, nor a mistake in the call', () => {
    for (const status of [400, 403, 404, 409, 410, 413, 422]) {
      expect(showsCommonlyUnreachable(new HttpError(status, null))).toBe(false);
    }
    expect(showsCommonlyUnreachable(new Error('prUrl must be https://github.com/<owner>/<repo>/pull/<n>'))).toBe(false);
  });

  test('the answerable statuses are the CLI\'s, so the two sides judge a failure alike', () => {
    const cliSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../cli/src/lib/public-tool-error.js'), 'utf8');
    const literal = /ANSWERABLE_API_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(cliSource)?.[1];
    expect(literal).toBeDefined();
    expect(literal.split(',').map((s) => Number(s.trim())).sort()).toEqual([...ANSWERABLE_API_STATUSES].sort());
  });

  test('every tool listed as a read exists, so the list cannot drift into names that gate nothing', () => {
    const names = new Set(buildTools(cfg).map((tool) => tool.name));
    for (const name of READ_ONLY_TOOLS) expect(names.has(name)).toBe(true);
    expect(names.has('commonly_post_message') && !READ_ONLY_TOOLS.has('commonly_post_message')).toBe(true);
  });
});

describe('a public seat', () => {
  test('refuses every write after a 503, with only the fixed line, and keeps reading', async () => {
    const calls = scriptFetch([{ status: 503, body: { message: 'upstream unavailable' } }, { status: 200, body: { messages: [] } }]);
    const { call, client } = await connect(PUBLIC);
    const failed = await call(...READ);
    expect(failed.isError).toBe(true);
    const before = calls.length;
    for (const [name, args] of [POST, ['commonly_post_thread_comment', { postId: 'p1', content: 'hi' }], ['commonly_react_to_message', { messageId: 'm1', emoji: '👍' }], ['commonly_dm_agent', { agentName: 'x' }]]) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await call(name, args);
      expect(refused).toMatchObject({ isError: true });
      expect(refused.content).toEqual([{ type: 'text', text: UNREACHABLE_REFUSAL }]);
    }
    expect(calls.length).toBe(before);
    const read = await call(...READ);
    expect(read.isError).toBeFalsy();
    await client.close();
  });

  test('a call that got no answer latches it too', async () => {
    scriptFetch([new Error('fetch failed'), { status: 200, body: {} }]);
    const { call, client } = await connect(PUBLIC);
    await call(...READ);
    expect(text(await call(...POST))).toBe(UNREACHABLE_REFUSAL);
    await client.close();
  });

  test('a failed check-in at start latches it, as index.js reports one', async () => {
    const calls = scriptFetch([{ status: 200, body: {} }]);
    const { handle, call, client } = await connect(PUBLIC);
    handle.gate.observe(new TransportError(new Error('connect ECONNREFUSED')));
    expect(text(await call(...POST))).toBe(UNREACHABLE_REFUSAL);
    expect(calls).toHaveLength(0);
    await client.close();
  });

  test('an answerable refusal does not latch: the next post goes out', async () => {
    const calls = scriptFetch([{ status: 404, body: { message: 'Pod not found' } }, { status: 201, body: { ok: true } }]);
    const { call, client } = await connect(PUBLIC);
    expect((await call(...READ)).isError).toBe(true);
    const posted = await call(...POST);
    expect(posted.isError).toBeFalsy();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    await client.close();
  });

  test('a missing argument does not latch', async () => {
    scriptFetch([{ status: 201, body: { ok: true } }]);
    const { call, client } = await connect(PUBLIC);
    expect((await call('commonly_post_message', { content: 'no pod' })).isError).toBe(true);
    expect((await call(...POST)).isError).toBeFalsy();
    await client.close();
  });

  test('the latch belongs to its process: a new server starts open', async () => {
    scriptFetch([{ status: 503, body: {} }, { status: 201, body: { ok: true } }]);
    const first = await connect(PUBLIC);
    await first.call(...READ);
    expect(text(await first.call(...POST))).toBe(UNREACHABLE_REFUSAL);
    await first.client.close();
    const second = await connect(PUBLIC);
    expect((await second.call(...POST)).isError).toBeFalsy();
    await second.client.close();
  });
});

describe('without the flag', () => {
  test.each([
    ['absent', {}],
    ['set to anything but 1', { [PUBLIC_SEAT_ENV]: 'true' }],
  ])('(%s) a seat keeps writing through a 503', async (_label, env) => {
    const calls = scriptFetch([{ status: 503, body: { message: 'upstream unavailable' } }, { status: 201, body: { ok: true } }]);
    const { handle, call, client } = await connect(env);
    expect((await call(...READ)).isError).toBe(true);
    const posted = await call(...POST);
    expect(posted.isError).toBeFalsy();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(handle.gate.latched).toBe(false);
    await client.close();
  });
});
