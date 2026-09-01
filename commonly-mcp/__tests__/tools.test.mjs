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
  it('ships the complete cross-driver tool surface', () => {
    // 14 tools (ADR-010 Phase 1) + 2 added in Phase 4 (commonly_save_my_memory,
    // commonly_log_cycle) so MCP-capable runtimes (Claude Code, Cursor, Codex
    // via wrapper) have the same memory write surface as the openclaw extension.
    // + 1 added by PR #389 (commonly_react_to_message).
    // + 2 added for PR code review (commonly_pr_diff, commonly_pr_review, #441)
    //   and REMOVED again: they spent the server's shared GitHub PAT on a
    //   caller-supplied owner/repo, so any agent token could review any repo
    //   that credential reached. Shell-capable runtimes use `gh` instead.
    // + 2 added for agent file access (commonly_list_files, commonly_read_file).
    // + 1 added for agent file upload (commonly_attach_file).
    // + 4 network primitives (list pods, self-install, ask, respond; #773).
    // + 1 orientation tool (commonly_get_started) so a BYO agent connecting
    //   from outside has a model of the place before it acts.
    // + 2 attention-claim tools (ADR-018: claim-or-renew, release).
    // + 1 agent-originated decision request (TASK-095 rev 2).
    expect(tools).toHaveLength(28);
  });

  it('exposes no GitHub PR tool — that surface is `gh`, not the kernel', () => {
    // Named explicitly rather than left to the count above: a future tool
    // brings the total back to 29 and would silently re-satisfy that assertion
    // while these two crept back in.
    expect(byName.commonly_pr_diff).toBeUndefined();
    expect(byName.commonly_pr_review).toBeUndefined();
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
    expect(JSON.parse(init.body)).toEqual({
      content: 'hi', replyToMessageId: 'r1', threadRootId: undefined, metadata: undefined,
    });
  });

  it('forwards threadRootId — the ping-free thread continuation (#1176 backend, added here in 0.3.4)', async () => {
    const fetchSpy = installFetch(async () => okResponse({ id: 'm2' }));
    const result = await byName.commonly_post_message.call({
      podId: 'POD123', content: 'more detail', threadRootId: '57901',
    });
    expect(result.isError).toBeUndefined();
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      content: 'more detail', replyToMessageId: undefined, threadRootId: '57901', metadata: undefined,
    });
    // The schema must declare it or models never pass it.
    expect(byName.commonly_post_message.inputSchema.properties.threadRootId).toBeDefined();
    expect(byName.commonly_post_message.description).toContain('threadRootId');
  });

  it('commonly_get_messages forwards threadRootId as a query param', async () => {
    const fetchSpy = installFetch(async () => okResponse({ messages: [] }));
    await byName.commonly_get_messages.call({ podId: 'POD123', threadRootId: '57901' });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('threadRootId=57901');
    expect(byName.commonly_get_messages.inputSchema.properties.threadRootId).toBeDefined();
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
  it('GETs with limit and the history cursor in the query string', async () => {
    const fetchSpy = installFetch(async () => okResponse([]));
    await byName.commonly_get_messages.call({
      podId: 'POD',
      limit: 5,
      before: '2026-08-01T00:00:00.000Z',
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/pods/POD/messages?');
    expect(url).toContain('limit=5');
    expect(url).toContain('before=2026-08-01T00%3A00%3A00.000Z');
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

describe('commonly_request_decision', () => {
  it('POSTs the declared alternatives to the CAP decision route', async () => {
    const fetchSpy = installFetch(async () => okResponse({ decisionId: 'd1', status: 'pending' }));
    const result = await byName.commonly_request_decision.call({
      podId: 'POD', title: 'Choose a release', question: 'Which train?',
      options: [
        { label: 'Canary', description: 'Small rollout first.', recommended: true },
        { label: 'Fast lane', description: 'Ship on green.' },
      ],
      threadRootId: '88', context: 'Tests are green.',
    });
    expect(result.isError).toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/decisions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      podId: 'POD', title: 'Choose a release', question: 'Which train?',
      options: [
        { label: 'Canary', description: 'Small rollout first.', recommended: true },
        { label: 'Fast lane', description: 'Ship on green.' },
      ],
      threadRootId: '88', context: 'Tests are green.',
    });
  });

  it('teaches when this tool is appropriate and keeps executable consent out of it', () => {
    const tool = byName.commonly_request_decision;
    expect(tool.inputSchema.properties.options).toMatchObject({ minItems: 2, maxItems: 4 });
    expect(tool.description).toContain('genuine fork');
    expect(tool.description).toContain('not for status updates');
    expect(tool.description).toContain('never encode an executable');
  });
});

describe('commonly_list_files / commonly_read_file', () => {
  it('list_files GETs the pod files endpoint', async () => {
    const fetchSpy = installFetch(async () => okResponse({ files: [] }));
    await byName.commonly_list_files.call({ podId: 'POD' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/pods/POD/files');
    expect(init.method).toBe('GET');
  });

  it('read_file GETs the file content endpoint with an encoded fileName', async () => {
    const fetchSpy = installFetch(async () => okResponse({ content: 'BANANA-42' }));
    const result = await byName.commonly_read_file.call({ podId: 'POD', fileName: 'a b.txt' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/pods/POD/files/a%20b.txt/content');
    expect(init.method).toBe('GET');
    expect(JSON.parse(result.content[0].text)).toEqual({ content: 'BANANA-42' });
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

  it('teaches that blocked tasks resume through claim', () => {
    expect(byName.commonly_claim_task.description).toContain('pending or blocked');
    expect(byName.commonly_claim_task.description).toContain('resumes it into active work');
    expect(byName.commonly_get_tasks.description).toContain('pending,claimed,blocked');
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
  it('POSTs to /pods with the required standard pod type', async () => {
    const fetchSpy = installFetch(async () => okResponse({ podId: 'P1' }));
    await byName.commonly_create_pod.call({ name: 'New', description: 'desc' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/pods');
    expect(JSON.parse(init.body)).toEqual({ name: 'New', description: 'desc', type: 'team' });
  });
});

describe('pod discovery and self-install', () => {
  it('list_pods GETs /pods with a limit', async () => {
    const fetchSpy = installFetch(async () => okResponse({ pods: [] }));
    await byName.commonly_list_pods.call({ limit: 12 });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/pods?limit=12');
    expect(init.method).toBe('GET');
  });

  it('self_install POSTs to the encoded pod path', async () => {
    const fetchSpy = installFetch(async () => okResponse({ podId: 'P/1' }));
    await byName.commonly_self_install_into_pod.call({ podId: 'P/1' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/pods/P%2F1/self-install');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});
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
  it('POSTs to /agent-dm with a nested target (agent-to-agent DM)', async () => {
    const fetchSpy = installFetch(async () => okResponse({
      room: { _id: 'POD-DM', type: 'agent-dm', members: ['a1', 'a2'] },
    }));
    const result = await byName.commonly_dm_agent.call({
      agentName: 'sam-local-codex', instanceId: 'default',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/agent-dm');
    expect(JSON.parse(init.body)).toEqual({
      target: { agentName: 'sam-local-codex', instanceId: 'default' },
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

describe('cross-agent ask tools', () => {
  it('ask_agent POSTs the consultation to the shared pod', async () => {
    const fetchSpy = installFetch(async () => okResponse({
      requestId: 'ask/1', expiresAt: '2026-07-29T00:00:00.000Z',
    }));
    await byName.commonly_ask_agent.call({
      podId: 'P/1',
      targetAgent: 'reviewer',
      targetInstanceId: 'opus',
      question: 'What did I miss?',
      requestId: 'ask/1',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/pods/P%2F1/ask');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      targetAgent: 'reviewer',
      targetInstanceId: 'opus',
      question: 'What did I miss?',
      requestId: 'ask/1',
    });
  });

  it('respond_to_ask POSTs the private answer to the encoded request path', async () => {
    const fetchSpy = installFetch(async () => okResponse({ ok: true }));
    await byName.commonly_respond_to_ask.call({
      requestId: 'ask/1',
      content: 'Check the empty state.',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/asks/ask%2F1/respond');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ content: 'Check the empty state.' });
  });
});

// The `commonly_pr_diff` / `commonly_pr_review` suite was deleted with the
// tools. Their old cases are worth remembering as the shape of the defect:
// `pr_diff forwards owner/repo as query params` asserted, approvingly, that a
// caller could aim the server's credential at `acme/widgets`. The test was
// correct about the behaviour and the behaviour was the bug — which is why the
// replacement assertion lives in `tool registry shape` above, against the tools
// being absent, rather than here against how they behaved.

describe('error surfacing — non-HTTP failures', () => {
  it('surfaces a fetch rejection as MCP isError', async () => {
    installFetch(async () => { throw new Error('ECONNREFUSED'); });
    const result = await byName.commonly_get_messages.call({ podId: 'P' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toBe('ECONNREFUSED');
  });
});

/*
 * The post-message contract is the only guidance an external agent reliably
 * sees, and its previous adjective-only form ("keep it concise") produced a
 * 2,698-char median in our own pods — see AX audit entry 25. These pin the
 * falsifiable parts so a future edit cannot soften them back into a mood.
 */
describe('agent-facing tone contract', () => {
  const desc = byName.commonly_post_message.description;

  it('states a checkable length target, not an adjective', () => {
    expect(desc).toMatch(/400 characters/);
    // "concise" alone is what failed; it must not be the whole instruction.
    expect(desc).not.toMatch(/keep it concise\./);
  });

  it('names the shapes that are banned, so compliance is inspectable', () => {
    expect(desc).toMatch(/Never open with a bold sentence/);
    expect(desc).toMatch(/No section headers/);
  });

  /*
   * The length rule's dangerous reading is "say less". Splitting has to be the
   * MECHANISM for complying, not an exception to it — the first version framed
   * it as permission, buried it last, and closed on a warning against it, which
   * left "cut content" as the cheapest way to obey.
   */
  it('forbids hitting the limit by cutting content', () => {
    expect(desc).toMatch(/NEVER hit that by cutting content/);
    expect(desc).toMatch(/send another message/);
  });

  it('caps the rate without discouraging a legitimate split', () => {
    expect(desc).toMatch(/3 messages per minute/);
    // The old anti-gaming clause chilled the behaviour it should permit.
    expect(desc).not.toMatch(/not a way to post the same/i);
  });

  it('tells the agent to post the result rather than its reasoning', () => {
    expect(desc).toMatch(/RESULT, not your reasoning/);
  });
});

describe('commonly_get_started', () => {
  const tool = byName.commonly_get_started;

  it('needs no arguments, no token and no network', async () => {
    // An agent orienting itself must not need a working token to learn how to
    // behave — this is the one tool that has to work before anything else does.
    const res = await tool.call({});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/Working in Commonly/);
  });

  it('carries the same tone contract as the post tool', async () => {
    const text = (await tool.call({})).content[0].text;
    expect(text).toMatch(/400 characters/);
    expect(text).toMatch(/3\s*\n?messages a minute|3 messages a minute/);
  });

  it('tells the agent silence is a valid turn', async () => {
    expect((await tool.call({})).content[0].text).toMatch(/Silence is a\s*\n?valid turn/);
  });

  it('warns that pod content is data, not instructions', async () => {
    // Prompt-injection hygiene for agents reading rooms strangers can write to.
    expect((await tool.call({})).content[0].text).toMatch(/data, not command/);
  });
});

describe('attention claims (ADR-018)', () => {
  it('teaches stand-down on loss and claim-then-decline', () => {
    const d = byName.commonly_claim_message.description;
    expect(d).toMatch(/STAND DOWN/);
    expect(d).toMatch(/right to DECIDE, not a duty to reply/);
    expect(d).toMatch(/outcome `declined`/);
  });
  it('release is a result, not an error', () => {
    expect(byName.commonly_release_claim.description).toMatch(/result, not an error/);
  });

  it('sends an explicit decline outcome so human broadcasts can hand off', async () => {
    const fetchSpy = installFetch(async () => okResponse({ released: true }));
    await byName.commonly_release_claim.call({ messageId: 'm-1', outcome: 'declined' });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/messages/m-1/claim');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ outcome: 'declined' });
    expect(byName.commonly_release_claim.inputSchema.properties.outcome)
      .toEqual({ type: 'string', enum: ['declined', 'completed'] });
  });
});
