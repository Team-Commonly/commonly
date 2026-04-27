/**
 * @commonly/mcp tools — argument routing, MCP shape, error surfacing.
 *
 * The tools module is data + thin handlers. We feed each tool a fake `request`
 * (via the same _fetchImpl seam in client.js) and assert the wire shape.
 */

import { jest } from '@jest/globals';
import { buildTools } from '../src/tools.js';
import { HttpError } from '../src/client.js';

const cfg = { baseUrl: 'https://x.example', token: 'cm_agent_t' };

const tools = buildTools(cfg);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

describe('tool registry shape', () => {
  it('ships exactly the v1 surface (14 tools)', () => {
    expect(tools).toHaveLength(14);
  });

  it('every tool has name, description, inputSchema, call', () => {
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toMatchObject({ type: 'object' });
      expect(typeof t.call).toBe('function');
    }
  });

  it('every tool name uses the commonly_<verb> convention', () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^commonly_[a-z_]+$/);
    }
  });
});

// ── Wire-shape tests — patch the global fetch the client uses ───────────────

const installFetch = (handler) => {
  const fn = jest.fn(handler);
  global.fetch = fn;
  return fn;
};

const okResponse = (body) => ({
  ok: true, status: 200, text: async () => JSON.stringify(body),
});

afterEach(() => { delete global.fetch; });

describe('commonly_post_message', () => {
  it('POSTs to the right path with body', async () => {
    const fetchSpy = installFetch(async () => okResponse({ id: 'm1' }));
    const result = await byName.commonly_post_message.call({
      podId: 'POD123', content: 'hi', replyToMessageId: 'r1',
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'm1' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/pods/POD123/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ content: 'hi', replyToMessageId: 'r1', metadata: undefined });
  });

  it('surfaces 4xx as MCP isError', async () => {
    installFetch(async () => ({
      ok: false, status: 400,
      text: async () => JSON.stringify({ message: 'bad request' }),
    }));
    const result = await byName.commonly_post_message.call({ podId: 'P', content: 'x' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe(400);
    expect(payload.message).toBe('bad request');
  });
});

describe('commonly_get_messages', () => {
  it('GETs with limit in the query string', async () => {
    const fetchSpy = installFetch(async () => okResponse([]));
    await byName.commonly_get_messages.call({ podId: 'POD', limit: 5 });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/pods/POD/messages?');
    expect(url).toContain('limit=5');
  });
});

describe('commonly_get_context', () => {
  it('GETs the pod context endpoint', async () => {
    const fetchSpy = installFetch(async () => okResponse({ pod: {}, recentMessages: [] }));
    await byName.commonly_get_context.call({ podId: 'POD' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/pods/POD/context');
    expect(init.method).toBe('GET');
  });
});

describe('commonly_post_thread_comment', () => {
  it('POSTs to /threads/:threadId/comments (no podId in path)', async () => {
    const fetchSpy = installFetch(async () => okResponse({ id: 'c1' }));
    await byName.commonly_post_thread_comment.call({
      threadId: 'T1', content: 'reply',
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/threads/T1/comments');
  });
});

describe('commonly_get_tasks / create / claim / complete / update', () => {
  it('get_tasks GETs /api/v1/tasks/:podId with query filters', async () => {
    const fetchSpy = installFetch(async () => okResponse([]));
    await byName.commonly_get_tasks.call({
      podId: 'POD', assignee: 'nova', status: 'pending,claimed',
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/api/v1/tasks/POD?');
    expect(url).toContain('assignee=nova');
    expect(url).toContain('status=pending');
  });

  it('create_task POSTs with the body fields verbatim', async () => {
    const fetchSpy = installFetch(async () => okResponse({ taskId: 'TASK-001' }));
    await byName.commonly_create_task.call({
      podId: 'POD', title: 'do the thing', assignee: 'nova', dep: 'TASK-000',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/v1/tasks/POD');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      title: 'do the thing', assignee: 'nova', dep: 'TASK-000',
      parentTask: undefined, source: undefined, sourceRef: undefined,
    });
  });

  it('claim_task hits /:podId/:taskId/claim', async () => {
    const fetchSpy = installFetch(async () => okResponse({ ok: true }));
    await byName.commonly_claim_task.call({ podId: 'POD', taskId: 'TASK-001' });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/v1/tasks/POD/TASK-001/claim');
  });

  it('complete_task hits /:podId/:taskId/complete with prUrl + notes', async () => {
    const fetchSpy = installFetch(async () => okResponse({ ok: true }));
    await byName.commonly_complete_task.call({
      podId: 'POD', taskId: 'TASK-001', prUrl: 'https://gh/pr/1', notes: 'done',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/v1/tasks/POD/TASK-001/complete');
    expect(JSON.parse(init.body)).toEqual({ prUrl: 'https://gh/pr/1', notes: 'done' });
  });

  it('update_task hits /:podId/:taskId/updates with text', async () => {
    const fetchSpy = installFetch(async () => okResponse({ ok: true }));
    await byName.commonly_update_task.call({
      podId: 'POD', taskId: 'TASK-001', text: 'still working',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/v1/tasks/POD/TASK-001/updates');
    expect(JSON.parse(init.body)).toEqual({ text: 'still working' });
  });
});

describe('commonly_create_pod', () => {
  it('POSTs to /pods with name + description', async () => {
    const fetchSpy = installFetch(async () => okResponse({ podId: 'P1' }));
    await byName.commonly_create_pod.call({ name: 'New', description: 'desc' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/pods');
    expect(JSON.parse(init.body)).toEqual({ name: 'New', description: 'desc' });
  });
});

describe('memory tools', () => {
  it('read_agent_memory GETs /memory', async () => {
    const fetchSpy = installFetch(async () => okResponse({ content: '...' }));
    await byName.commonly_read_agent_memory.call({});
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/memory');
    expect(init.method).toBe('GET');
  });

  it('write_agent_memory PUTs /memory with the body', async () => {
    const fetchSpy = installFetch(async () => okResponse({ ok: true }));
    await byName.commonly_write_agent_memory.call({ content: 'new memory' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/memory');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ content: 'new memory', sections: undefined });
  });
});

describe('commonly_dm_agent', () => {
  it('POSTs to /room with agentName + instanceId', async () => {
    const fetchSpy = installFetch(async () => okResponse({
      room: { _id: 'POD-DM', type: 'agent-room', members: ['a1', 'a2'] },
    }));
    const result = await byName.commonly_dm_agent.call({
      agentName: 'sam-local-codex', instanceId: 'default',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/room');
    expect(JSON.parse(init.body)).toEqual({
      agentName: 'sam-local-codex', instanceId: 'default',
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.room._id).toBe('POD-DM');
  });

  it('surfaces 400 self-DM rejection from the backend', async () => {
    installFetch(async () => ({
      ok: false, status: 400,
      text: async () => JSON.stringify({ message: 'Cannot DM yourself' }),
    }));
    const result = await byName.commonly_dm_agent.call({ agentName: 'self' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toBe('Cannot DM yourself');
  });
});

describe('error surfacing — non-HTTP failures', () => {
  it('surfaces a fetch rejection as MCP isError', async () => {
    installFetch(async () => { throw new Error('ECONNREFUSED'); });
    const result = await byName.commonly_get_messages.call({ podId: 'P' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toBe('ECONNREFUSED');
  });
});
