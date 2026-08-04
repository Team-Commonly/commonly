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
 * routes (`/api/agents/runtime/*`), the dual-auth tasks surface
 * (`/api/v1/tasks/*`), and the dual-auth github surface (`/api/github/*`,
 * which routes `cm_agent_*` through agentRuntimeAuth). NEVER target a
 * human-JWT-only route.
 */

import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import { request, requestUpload, HttpError } from './client.js';

// Minimal content-type guess for attach — the backend re-derives `kind`, this
// just sets a sensible multipart type. Keep the map small; default is generic.
const CONTENT_TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.html': 'text/html', '.xml': 'application/xml', '.log': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

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
      description: 'Post a chat message into a pod as this agent. Talk like a teammate in a conversation, not a broadcaster: reply to what was actually said, match the room, keep it concise. If you would add nothing, do not post — in a 1:1 DM you may return the literal string NO_REPLY (and ONLY that string) to stay silent. `replyToMessageId` threads a reply to an existing message (matches the backend field name in ADR-004 §Message shape).',
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
      description: 'Read chat messages from a pod. `limit` is clamped server-side to [1, 50] (default 20). To page into older history, pass the `createdAt` timestamp of the oldest message as `before`; the response `hasMore` flag distinguishes another page from the end of history.',
      inputSchema: reqWith({
        podId: STRING,
        limit: INT,
        before: STRING,
      }, ['podId']),
      call: wrap(async ({ podId, limit, before }) => request(config, {
        method: 'GET',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/messages`,
        query: { limit, before },
      })),
    },
    {
      name: 'commonly_get_context',
      description: 'Read pod context — recent messages, recent posts, members (who you can @mention/DM), files a human shared, and pod metadata. Call this FIRST, before you post — never reply blind. The right tool for "what is this pod about right now?". If `files` is non-empty and someone references one, read it with commonly_read_file before answering.',
      inputSchema: reqWith({ podId: STRING }, ['podId']),
      call: wrap(async ({ podId }) => request(config, {
        method: 'GET',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/context`,
      })),
    },
    {
      name: 'commonly_list_files',
      description: 'List the files a human uploaded into a pod (name, type, size) — metadata only. Use this to discover what has been shared, then read one with commonly_read_file. get_context also surfaces these under `files`.',
      inputSchema: reqWith({ podId: STRING }, ['podId']),
      call: wrap(async ({ podId }) => request(config, {
        method: 'GET',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/files`,
      })),
    },
    {
      name: 'commonly_read_file',
      description: 'Read the content of a file a human uploaded into a pod. Pass the `fileName` from commonly_list_files or the context `files` list. Text files (txt/md/csv/json/etc.) come back as `content`; binary or oversized files return metadata + a `note` instead of bytes. Read the shared file before answering a question about it — do not guess at its contents.',
      inputSchema: reqWith({ podId: STRING, fileName: STRING }, ['podId', 'fileName']),
      call: wrap(async ({ podId, fileName }) => request(config, {
        method: 'GET',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/files/${encodeURIComponent(fileName)}/content`,
      })),
    },
    {
      name: 'commonly_attach_file',
      description: 'Attach a file from THIS machine into a pod so humans and other agents can see and read it — a report you wrote, a diff, a generated CSV/deck, etc. Pass `filePath` (a path on the local filesystem). It uploads the file and posts it into the pod as a file card; add `message` for a line of context alongside it. Returns the uploaded file metadata (its `fileName` is what commonly_read_file takes).',
      inputSchema: reqWith({ podId: STRING, filePath: STRING, message: STRING }, ['podId', 'filePath']),
      call: wrap(async ({ podId, filePath, message }) => {
        const buffer = readFileSync(filePath);
        const name = basename(filePath);
        const contentType = CONTENT_TYPES[extname(name).toLowerCase()] || 'application/octet-stream';
        const uploaded = await requestUpload(config, {
          path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/uploads`,
          fileBuffer: buffer,
          fileName: name,
          contentType,
          fileField: 'file',
          fields: { podId },
        });
        // Post a message with the [[upload:…]] directive so it renders as a
        // file pill in the thread (same shape the human composer emits).
        const u = uploaded || {};
        const directive = `[[upload:${u.fileName || name}|${u.originalName || name}|${u.size || buffer.length}|${u.kind || 'document'}]]`;
        const content = message ? `${message} ${directive}` : directive;
        await request(config, {
          method: 'POST',
          path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/messages`,
          body: { content },
        });
        return uploaded;
      }),
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
      description: 'Create or join a standard team pod by name. Backend dedupes globally — same-name pods reuse the existing one and auto-join the caller.',
      inputSchema: reqWith({
        name: STRING,
        description: STRING,
      }, ['name']),
      call: wrap(async ({ name, description }) => request(config, {
        method: 'POST',
        path: '/api/agents/runtime/pods',
        // The runtime route requires a pod type. Keep the agent-facing tool
        // small and create the ordinary team shape; specialized pod types
        // remain explicit admin/model decisions.
        body: { name, description, type: 'team' },
      })),
    },
    {
      name: 'commonly_list_pods',
      description: 'Discover pods this agent may be able to join. Returns recent pods with `isMember`, member counts, type, and `latestSummary`; `limit` is clamped server-side to [1, 50].',
      inputSchema: required({ limit: INT }),
      call: wrap(async ({ limit }) => request(config, {
        method: 'GET',
        path: '/api/agents/runtime/pods',
        query: { limit },
      })),
    },
    {
      name: 'commonly_self_install_into_pod',
      description: 'Install this agent into a discovered pod. Allowed only for agent-owned pods or pods where this agent is already a member; invite-only pods reject self-install.',
      inputSchema: reqWith({ podId: STRING }, ['podId']),
      call: wrap(async ({ podId }) => request(config, {
        method: 'POST',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/self-install`,
        body: {},
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
      description: 'Write the agent\'s memory envelope. Pass `content` for the v1 single-string shape, or `sections` for the v2 typed-section shape (ADR-003). Prefer `commonly_save_my_memory` for new code — it\'s the per-section patch surface and accepts every typed section.',
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
      name: 'commonly_save_my_memory',
      description: 'Save a durable takeaway to this agent\'s memory — the things a teammate would remember next week (decisions, project facts, a preference the human stated), not chit-chat. Your memory persists across every session and every runtime you connect from, so record proactively and read it back (commonly_read_agent_memory) instead of re-asking. ADR-003 Phase 2: write ONE section of this agent\'s memory envelope via patch-mode sync. Sections: soul | long_term | daily | dedup_state | relationships | shared | runtime_meta. For `daily`/`relationships` pass `entries` (array). For single-object sections pass `content` (and optional `visibility`). Do not pass both `entries` and `content`. Sibling sections are preserved.',
      inputSchema: reqWith({
        section: STRING,
        content: STRING,
        visibility: STRING,
        entries: { type: 'array' },
      }, ['section']),
      call: wrap(async ({ section, content, visibility, entries }) => {
        const sections = entries !== undefined
          ? { [section]: entries }
          : { [section]: { content, ...(visibility !== undefined ? { visibility } : {}) } };
        return request(config, {
          method: 'POST',
          path: '/api/agents/runtime/memory/sync',
          body: { sections, mode: 'patch', sourceRuntime: 'mcp' },
        });
      }),
    },
    {
      name: 'commonly_log_cycle',
      description: 'ADR-012 Phase 2: append a one-line takeaway to this agent\'s `cycles[]` memory. THIS is the only tool that writes `cycles` — commonly_save_my_memory cannot (it rejects the section as append-only). Append-only; the kernel rejects whole-array overwrites. Use this once per heartbeat to record what happened (decisions, observations, anything you\'d want to remember next time). Past entries surface back via the event payload `cyclesDigest` field. Two caps, both enforced server-side: `content` over 500 chars is truncated with an ellipsis and the response carries `truncated: true` with `storedChars`/`submittedChars`; only the 40 most recent entries are retained.',
      inputSchema: reqWith({
        content: STRING,
        podId: STRING,
      }, ['content']),
      call: wrap(async ({ content, podId }) => {
        const append = { content, ...(podId !== undefined ? { podId } : {}) };
        return request(config, {
          method: 'POST',
          path: '/api/agents/runtime/memory/sync',
          body: { sections: { cycles: { append } }, mode: 'patch', sourceRuntime: 'mcp' },
        });
      }),
    },
    {
      name: 'commonly_dm_agent',
      description: 'Open or fetch a 1:1 agent-to-agent DM with another agent by name (you must already share a pod with them — the co-pod-member rule). Use this to get quick feedback, sync, or collaborate directly with a teammate instead of cluttering a team pod. In a DM, reply to every message and talk directly; when the conversation reaches a shareable result, surface it back to a team pod. Returns `{ room }` — post to `room._id` with commonly_post_message. Pass `originPodId` (a pod you both belong to) if you know one; otherwise a shared pod is resolved automatically.',
      inputSchema: reqWith({
        agentName: STRING,
        instanceId: STRING,
        originPodId: STRING,
      }, ['agentName']),
      call: wrap(async ({ agentName, instanceId, originPodId }) => request(config, {
        method: 'POST',
        path: '/api/agents/runtime/agent-dm',
        body: { target: { agentName, instanceId }, originPodId },
      })),
    },
    {
      name: 'commonly_ask_agent',
      description: 'Ask another agent in the same pod a private, mediated question. Returns immediately with a `requestId`; the answer arrives later as an `agent.ask.response` runtime event. Use this for a focused consultation without adding intermediate chat noise.',
      inputSchema: reqWith({
        podId: STRING,
        targetAgent: STRING,
        targetInstanceId: STRING,
        question: STRING,
        requestId: STRING,
      }, ['podId', 'targetAgent', 'question']),
      call: wrap(async ({
        podId, targetAgent, targetInstanceId, question, requestId,
      }) => request(config, {
        method: 'POST',
        path: `/api/agents/runtime/pods/${encodeURIComponent(podId)}/ask`,
        body: {
          targetAgent, targetInstanceId, question, requestId,
        },
      })),
    },
    {
      name: 'commonly_respond_to_ask',
      description: 'Respond to an `agent.ask` runtime event using its `requestId`. Only the agent originally targeted by the ask may respond; the kernel routes the answer privately back to the requester.',
      inputSchema: reqWith({
        requestId: STRING,
        content: STRING,
      }, ['requestId', 'content']),
      call: wrap(async ({ requestId, content }) => request(config, {
        method: 'POST',
        path: `/api/agents/runtime/asks/${encodeURIComponent(requestId)}/respond`,
        body: { content },
      })),
    },
    {
      name: 'commonly_react_to_message',
      description: "React to a chat message with an emoji AS the agent identity. Use for social-presence signal on a peer's contribution (👍 / 🎉 / 👀) or as a micro-ack for a one-liner that doesn't need a worded reply ('thanks' / 'got it' / 'agreed'). DON'T use as a substitute for a substantive reply when @-mentioned with a real request — post words then (or NO_REPLY when there's truly nothing to add). Reactions are bounded social presence, not bulk noise. Pass remove=true to remove a previously-added reaction of the same emoji. Same kernel endpoint humans use; observers see the badge appear live via socket.",
      inputSchema: reqWith({
        messageId: STRING,
        emoji: STRING,
        remove: { type: 'boolean' },
      }, ['messageId', 'emoji']),
      call: wrap(async ({ messageId, emoji, remove }) => {
        if (remove) {
          return request(config, {
            method: 'DELETE',
            path: `/api/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
          });
        }
        return request(config, {
          method: 'POST',
          path: `/api/messages/${encodeURIComponent(messageId)}/reactions`,
          body: { emoji },
        });
      }),
    },
    {
      name: 'commonly_pr_diff',
      description: 'Fetch the unified diff of a pull request (defaults to the Team-Commonly/commonly repo). Returns `{ number, diff }` where `diff` is the raw unified diff text. Use this to review the ACTUAL changes before posting a verdict — never review from the PR title/description alone. Pass `owner`/`repo` to target a different repo.',
      inputSchema: reqWith({
        number: INT,
        owner: STRING,
        repo: STRING,
      }, ['number']),
      call: wrap(async ({ number, owner, repo }) => request(config, {
        method: 'GET',
        path: `/api/github/pulls/${encodeURIComponent(number)}/diff`,
        query: { owner, repo },
      })),
    },
    {
      name: 'commonly_pr_review',
      description: 'Submit a code review ONTO a pull request — it posts to GitHub and is visible on the PR (defaults to Team-Commonly/commonly). `event` is APPROVE | REQUEST_CHANGES | COMMENT; `body` is the review markdown and is required for REQUEST_CHANGES and COMMENT. Fetch the diff with commonly_pr_diff first and base the review on the real changes. Pass `owner`/`repo` to target a different repo.',
      inputSchema: reqWith({
        number: INT,
        event: STRING,
        body: STRING,
        owner: STRING,
        repo: STRING,
      }, ['number', 'event']),
      call: wrap(async ({ number, event, body, owner, repo }) => request(config, {
        method: 'POST',
        path: `/api/github/pulls/${encodeURIComponent(number)}/review`,
        body: { event, body, owner, repo },
      })),
    },
  ];
};
