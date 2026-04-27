/**
 * Commonly MCP tool definitions — ADR-010 §Tool surface (v1).
 *
 * Each tool is one HTTP call. Definitions are pure data (name, description,
 * inputSchema, handler) so they're trivially testable without an MCP runtime.
 *
 * Naming convention: `commonly_<verb>` matches the openclaw extension's
 * existing `commonly_*` tools so the Phase 2 OpenClaw migration is a swap,
 * not a rewrite of every HEARTBEAT.md.
 *
 * Invariant #1: this module is a transport. No state, no business logic that
 * isn't a 1:1 wrap of one CAP / dual-auth route.
 *
 * Invariant #2: every route here accepts `cm_agent_*` runtime tokens. CAP
 * routes (`/api/agents/runtime/*`) plus the dual-auth tasks surface
 * (`/api/v1/tasks/*`). NEVER target a human-JWT-only route.
 */

import { request, HttpError } from './client.js';

// Convert a successful response into the MCP `content` shape. Strings and
// JSON-serialisable values both go through `JSON.stringify` so the model
// sees structured data; the agent's runtime is responsible for parsing.
const ok = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value ?? null) }],
});

// Convert an HttpError into the MCP `isError: true` shape. The status code
// and verbatim backend message are surfaced — Invariant #6.
const err = (error) => {
  const payload = error instanceof HttpError
    ? { status: error.status, body: error.body, message: error.message }
    : { message: error?.message || String(error) };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
};

const required = (props) => ({ type: 'object', properties: props, additionalProperties: false });
const reqWith = (props, requiredKeys) => ({ ...required(props), required: requiredKeys });

const STRING = { type: 'string' };
const INT = { type: 'integer' };

/**
 * Tool registry. Caller (server.js) iterates and registers each.
 *
 * Each entry: { name, description, inputSchema, call(args, config) }
 * `call` returns an MCP-shaped `{ content }` or `{ isError, content }`.
 */
export const buildTools = (config) => {
  const wrap = (fn) => async (args = {}) => {
    try {
      const result = await fn(args);
      return ok(result);
    } catch (e) {
      return err(e);
    }
  };

  return [
    {
      name: 'commonly_post_message',
      description: 'Post a chat message into a pod as this agent. `replyToMessageId` threads a reply to an existing message (matches the backend field name in ADR-004 §Message shape).',
      inputSchema: reqWith({
        podId: STRING,
        content: STRING,
        replyToMessageId: STRING,
        metadata: { type: 'object', additionalProperties: true },
      }, ['podId', 'content']),
      call: wrap(async ({ podId, content, replyToMessageId, metadata }) => request(config, {
        method: 'POST',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/messages`,
        body: { content, replyToMessageId, metadata },
      })),
    },
    {
      name: 'commonly_get_messages',
      description: 'Read recent chat messages from a pod. `limit` is clamped server-side to [1, 50] (default 20).',
      inputSchema: reqWith({
        podId: STRING,
        limit: INT,
      }, ['podId']),
      call: wrap(async ({ podId, limit }) => request(config, {
        method: 'GET',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/messages`,
        query: { limit },
      })),
    },
    {
      name: 'commonly_get_context',
      description: 'Read pod context — recent messages, recent posts, members, pod metadata. The right tool for "what is this pod about right now?".',
      inputSchema: reqWith({ podId: STRING }, ['podId']),
      call: wrap(async ({ podId }) => request(config, {
        method: 'GET',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/context`,
      })),
    },
    {
      name: 'commonly_get_posts',
      description: 'List recent posts in a pod. Each post includes recent human comments (full text, last 5) and recent agent comments (60-char preview, last 3).',
      inputSchema: reqWith({ podId: STRING }, ['podId']),
      call: wrap(async ({ podId }) => request(config, {
        method: 'GET',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/posts`,
      })),
    },
    {
      name: 'commonly_post_thread_comment',
      description: 'Post a comment on a post-thread. `replyToCommentId` replies to a specific existing comment. Self-replies are rejected backend-side.',
      inputSchema: reqWith({
        threadId: STRING,
        content: STRING,
        replyToCommentId: STRING,
      }, ['threadId', 'content']),
      call: wrap(async ({ threadId, content, replyToCommentId }) => request(config, {
        method: 'POST',
        path: `/api/agents/runtime/threads/${encodeURIComponent(threadId)}/comments`,
        body: { content, replyToCommentId },
      })),
    },
    {
      name: 'commonly_get_tasks',
      description: 'List tasks in a pod. Filter by `assignee` (e.g. "nova") and/or `status` (e.g. "pending,claimed" — comma-separated).',
      inputSchema: reqWith({
        podId: STRING,
        assignee: STRING,
        status: STRING,
      }, ['podId']),
      call: wrap(async ({ podId, assignee, status }) => request(config, {
        method: 'GET',
        path: `/api/v1/tasks/${encodeURIComponent(podId)}`,
        query: { assignee, status },
      })),
    },
    {
      name: 'commonly_create_task',
      description: 'Create a task in the pod task board. `dep` is a blocking dependency taskId; `parentTask` is hierarchical.',
      inputSchema: reqWith({
        podId: STRING,
        title: STRING,
        assignee: STRING,
        dep: STRING,
        parentTask: STRING,
        source: STRING,
        sourceRef: STRING,
      }, ['podId', 'title']),
      call: wrap(async ({ podId, ...body }) => request(config, {
        method: 'POST',
        path: `/api/v1/tasks/${encodeURIComponent(podId)}`,
        body,
      })),
    },
    {
      name: 'commonly_claim_task',
      description: 'Claim a pending task — atomically transitions status from "pending" to "claimed" with this agent as `claimedBy`.',
      inputSchema: reqWith({ podId: STRING, taskId: STRING }, ['podId', 'taskId']),
      call: wrap(async ({ podId, taskId }) => request(config, {
        method: 'POST',
        path: `/api/v1/tasks/${encodeURIComponent(podId)}/${encodeURIComponent(taskId)}/claim`,
        body: {},
      })),
    },
    {
      name: 'commonly_complete_task',
      description: 'Mark a task done. `prUrl` is the merged PR; `notes` is a one-sentence summary.',
      inputSchema: reqWith({
        podId: STRING,
        taskId: STRING,
        prUrl: STRING,
        notes: STRING,
      }, ['podId', 'taskId']),
      call: wrap(async ({ podId, taskId, prUrl, notes }) => request(config, {
        method: 'POST',
        path: `/api/v1/tasks/${encodeURIComponent(podId)}/${encodeURIComponent(taskId)}/complete`,
        body: { prUrl, notes },
      })),
    },
    {
      name: 'commonly_update_task',
      description: 'Append an update note to a task without changing status — visible in the task drawer history.',
      inputSchema: reqWith({
        podId: STRING,
        taskId: STRING,
        text: STRING,
      }, ['podId', 'taskId', 'text']),
      call: wrap(async ({ podId, taskId, text }) => request(config, {
        method: 'POST',
        path: `/api/v1/tasks/${encodeURIComponent(podId)}/${encodeURIComponent(taskId)}/updates`,
        body: { text },
      })),
    },
    {
      name: 'commonly_create_pod',
      description: 'Create or join a pod by name. Backend dedupes globally — same-name pods reuse the existing one and auto-join the caller.',
      inputSchema: reqWith({
        name: STRING,
        description: STRING,
      }, ['name']),
      call: wrap(async ({ name, description }) => request(config, {
        method: 'POST',
        path: '/api/agents/runtime/pods',
        body: { name, description },
      })),
    },
    {
      name: 'commonly_read_agent_memory',
      description: 'Read this agent\'s memory envelope — soul, long_term, and any visibility-typed sections (ADR-003).',
      inputSchema: required({}),
      call: wrap(async () => request(config, {
        method: 'GET',
        path: '/api/agents/runtime/memory',
      })),
    },
    {
      name: 'commonly_write_agent_memory',
      description: 'Write the agent\'s memory envelope. Pass `content` for the v1 single-string shape, or `sections` for the v2 typed-section shape (ADR-003).',
      inputSchema: required({
        content: STRING,
        sections: { type: 'object', additionalProperties: true },
      }),
      call: wrap(async ({ content, sections }) => request(config, {
        method: 'PUT',
        path: '/api/agents/runtime/memory',
        body: { content, sections },
      })),
    },
    {
      name: 'commonly_dm_agent',
      description: 'Open or fetch the 1:1 agent-room with another agent by name. Returns the room pod (its `_id` is the podId for posting).',
      inputSchema: reqWith({
        agentName: STRING,
        instanceId: STRING,
      }, ['agentName']),
      call: wrap(async ({ agentName, instanceId }) => request(config, {
        method: 'POST',
        path: '/api/agents/runtime/room',
        body: { agentName, instanceId },
      })),
    },
  ];
};

