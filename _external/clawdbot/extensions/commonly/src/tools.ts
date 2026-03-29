import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";

import { Type } from "@sinclair/typebox";

import type { AnyAgentTool } from "openclaw/plugin-sdk";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk";

const ACPX_BIN_CANDIDATES = [
  "/app/node_modules/.pnpm/node_modules/.bin/acpx", // plugin-local install
  "/app/extensions/acpx/node_modules/.bin/acpx",    // bundled extension binary
  "/app/node_modules/.bin/acpx",                    // hoisted pnpm
];

function resolveAcpxBin(): string {
  for (const candidate of ACPX_BIN_CANDIDATES) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not executable, try next
    }
  }
  return "acpx"; // fallback: hope it's in PATH
}

// Paths for Codex auth.json — shared PVC so init container and main container can both access.
const CODEX_AUTH_PATH = "/home/node/.codex/auth.json";
const CODEX_AUTH2_PATH = "/state/.codex/auth-2.json";
const CODEX_AUTH3_PATH = "/state/.codex/auth-3.json";

// Read the per-agent LiteLLM virtual key from the agent's auth-profiles.json.
// The provisioner writes the sk-xxx LiteLLM key to profiles['openai-codex:codex-cli'].access
// for both dev agents (injectLiteLLMVirtualKey) and community agents
// (injectOpenRouterKeyToAgentAuthProfiles). We read from there so that openrouter:default.key
// can hold the real OpenRouter API key (sk-or-v1-...) without being confused for LiteLLM.
function readAgentLiteLLMKey(agentId: string): string | null {
  try {
    const profilesPath = `/state/agents/${agentId}/agent/auth-profiles.json`;
    const profiles = JSON.parse(readFileSync(profilesPath, "utf8")) as {
      profiles?: Record<string, { key?: string; apiKey?: string; access?: string }>;
    };
    // Primary: openai-codex:codex-cli.access — LiteLLM virtual key written by provisioner
    const codexKey = profiles?.profiles?.["openai-codex:codex-cli"]?.access;
    if (typeof codexKey === "string" && codexKey.startsWith("sk-")) return codexKey;
    // Fallback: legacy location — openrouter:default.key, but only if it's a LiteLLM key
    // (LiteLLM keys are sk-xxx; real OpenRouter keys are sk-or-v1-xxx)
    const orProfile = profiles?.profiles?.["openrouter:default"];
    const orKey = orProfile?.key ?? orProfile?.apiKey;
    return typeof orKey === "string" && orKey.startsWith("sk-") && !orKey.startsWith("sk-or-v1-")
      ? orKey
      : null;
  } catch {
    return null;
  }
}

function isRateLimitError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("rate limit") ||
    m.includes("rate_limit") ||
    m.includes("ratelimit") ||
    m.includes("too many requests") ||
    m.includes("429") ||
    m.includes("quota exceeded") ||
    m.includes("requests per minute") ||
    m.includes("requests per day") ||
    // Weekly / monthly quota limits from chatgpt.com
    m.includes("weekly limit") ||
    m.includes("monthly limit") ||
    m.includes("daily limit") ||
    m.includes("usage limit") ||
    m.includes("usage cap") ||
    m.includes("cap reached") ||
    m.includes("limit reached") ||
    m.includes("limit exceeded") ||
    m.includes("over your limit") ||
    m.includes("insufficient_quota") ||
    m.includes("insufficient quota") ||
    m.includes("out of tokens") ||
    m.includes("credit balance") ||
    m.includes("ran out") ||
    // Codex ACP endpoint (chatgpt.com) returns 'RUNTIME: Internal error' when
    // the weekly Codex quota is exhausted — treat as rate limit to trigger account rotation.
    // NOTE: match the full prefix to avoid treating unrelated internal errors as rate limits.
    m.includes("runtime: internal error")
  );
}

interface AcpxError extends Error {
  acpxOutput?: string;
  acpxExitCode?: number | null;
}

function spawnAcpx(
  agentId: string,
  task: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = resolveAcpxBin();
    const args = [
      "--cwd", `/workspace/${agentId}`,
      "--agent", "npx @zed-industries/codex-acp -c model=gpt-5.4",
      "--approve-all",
      "--non-interactive-permissions", "deny",
      "exec", task,
    ];
    // Use agent workspace as cwd only if it exists — missing dir causes spawn ENOENT even
    // when the binary itself is valid (Node.js reports ENOENT against the binary path).
    const agentWorkspace = `/workspace/${agentId}`;
    const spawnCwd = existsSync(agentWorkspace) ? agentWorkspace : "/workspace";
    const child = spawn(bin, args, {
      cwd: spawnCwd,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`acpx timed out after ${timeoutMs / 1000}s`));
        return;
      }
      const output = stdout.trim() || stderr.trim();
      if (code === 0 || stdout.trim()) {
        resolve(output);
      } else {
        const err: AcpxError = new Error(stderr.trim() || `acpx exited with code ${code}`);
        err.acpxOutput = output;
        err.acpxExitCode = code;
        reject(err);
      }
    });
  });
}

async function runAcpx(
  agentId: string,
  task: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<string> {
  // Prefer LiteLLM path: use the per-agent virtual key (stored at openrouter:default in
  // auth-profiles.json) so that all Codex calls flow through LiteLLM's routing layer.
  // LiteLLM handles 3-account rotation, OpenRouter fallback, and logging internally.
  // We switch the auth.json to openai mode so codex-acp respects OPENAI_BASE_URL.
  const litellmBase = process.env.LITELLM_BASE_URL;
  const agentLiteLLMKey = litellmBase ? readAgentLiteLLMKey(agentId) : null;

  if (litellmBase && agentLiteLLMKey) {
    const originalAuth = (() => {
      try {
        return readFileSync(CODEX_AUTH_PATH, "utf8");
      } catch {
        return null;
      }
    })();
    try {
      writeFileSync(
        CODEX_AUTH_PATH,
        JSON.stringify({ auth_mode: "openai", OPENAI_API_KEY: agentLiteLLMKey }),
        "utf8",
      );
      const litellmEnv: Record<string, string> = {
        ...(extraEnv ?? {}),
        OPENAI_BASE_URL: `${litellmBase}/v1`,
        OPENAI_API_KEY: agentLiteLLMKey,
      };
      const output = await spawnAcpx(agentId, task, timeoutMs, litellmEnv);
      // LiteLLM exhausted (all Codex + OpenRouter fallbacks failed) — surface the error.
      if (isRateLimitError(output)) {
        throw new Error(`LiteLLM routing exhausted: ${output}`);
      }
      return output;
    } catch (err: unknown) {
      const acpxErr = err as AcpxError;
      const errMsg = acpxErr.acpxOutput ?? acpxErr.message ?? "";
      if (isRateLimitError(errMsg)) {
        throw new Error(`LiteLLM routing exhausted: ${errMsg}`);
      }
      throw err;
    } finally {
      if (originalAuth) {
        try {
          writeFileSync(CODEX_AUTH_PATH, originalAuth, "utf8");
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Fallback: direct chatgpt auth rotation (used when LiteLLM is not configured or key missing).
  // acpx codex connects to chatgpt.com using the OAuth token in CODEX_AUTH_PATH.
  let firstOutput: string | null = null;
  let firstRateLimited = false;

  try {
    firstOutput = await spawnAcpx(agentId, task, timeoutMs, extraEnv);
    if (isRateLimitError(firstOutput)) {
      firstRateLimited = true;
    } else {
      return firstOutput;
    }
  } catch (err: unknown) {
    const acpxErr = err as AcpxError;
    const errMsg = acpxErr.acpxOutput ?? acpxErr.message ?? "";
    if (!isRateLimitError(errMsg)) throw err;
    firstOutput = errMsg;
    firstRateLimited = true;
  }

  if (!firstRateLimited) return firstOutput!;

  // Rate-limited on account-1 — try account-2 then account-3 if available.
  const fallbackPaths = [CODEX_AUTH2_PATH, CODEX_AUTH3_PATH];
  let account1Backup: string | null = null;
  try { account1Backup = readFileSync(CODEX_AUTH_PATH, "utf8"); } catch { /* missing */ }

  let lastError = firstOutput;
  for (let i = 0; i < fallbackPaths.length; i++) {
    const fallbackPath = fallbackPaths[i];
    const accountNum = i + 2;
    let fallbackJson: string | null = null;
    try { fallbackJson = readFileSync(fallbackPath, "utf8"); } catch { /* not configured */ }
    if (!fallbackJson) continue;
    try {
      writeFileSync(CODEX_AUTH_PATH, fallbackJson, "utf8");
    } catch (writeErr: unknown) {
      throw new Error(`Codex rate-limited; failed to swap to account-${accountNum}: ${(writeErr as Error).message}`);
    }
    try {
      const output = await spawnAcpx(agentId, task, timeoutMs, extraEnv);
      if (!isRateLimitError(output)) return output;
      lastError = output;
    } catch (err: unknown) {
      const acpxErr = err as AcpxError;
      const errMsg = acpxErr.acpxOutput ?? acpxErr.message ?? "";
      if (!isRateLimitError(errMsg)) throw err;
      lastError = errMsg;
    } finally {
      if (account1Backup) {
        try { writeFileSync(CODEX_AUTH_PATH, account1Backup, "utf8"); } catch { /* ignore */ }
      }
    }
  }

  throw new Error(`Codex rate-limited on all configured accounts.\n${lastError}`);
}

// readStringArrayParam is not in plugin-sdk — inline a minimal version.
function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): string[] | undefined {
  const raw = (params as Record<string, unknown>)[key];
  if (Array.isArray(raw)) {
    return raw.filter((e) => typeof e === "string").map((e: string) => e.trim());
  }
  if (typeof raw === "string" && raw.trim()) {
    return [raw.trim()];
  }
  if (options.required) throw new Error(`${key} required`);
  return undefined;
}
import { CommonlyClient } from "./client.js";

const MemoryTargetSchema = Type.Unsafe<"daily" | "memory" | "skill">({
  type: "string",
  enum: ["daily", "memory", "skill"],
});

async function braveWebSearch(
  query: string,
  count = 5,
  retries = 1,
  freshness?: string,
  news = false,
): Promise<Array<{ title: string; url: string; description: string; age?: string }>> {
  const apiKey = process.env.BRAVE_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY not configured");
  }
  const endpoint = news ? "news" : "web";
  const params = new URLSearchParams({ q: query, count: String(count) });
  if (freshness) params.set("freshness", freshness);
  const url = `https://api.search.brave.com/res/v1/${endpoint}/search?${params.toString()}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
    if (res.status === 429 && attempt < retries) {
      continue; // retry after delay
    }
    if (!res.ok) {
      throw new Error(`Brave Search API error: ${res.status}`);
    }
    const data = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string; age?: string }> };
      results?: Array<{ title: string; url: string; description: string; age?: string }>;
    };
    return data.results ?? data.web?.results ?? [];
  }
  throw new Error("Brave Search API rate limited after retries");
}

export class CommonlyTools {
  private client: CommonlyClient;
  private tools: AnyAgentTool[];

  constructor(client: CommonlyClient) {
    this.client = client;
    this.tools = this.buildTools();
  }

  getToolDefinitions(): AnyAgentTool[] {
    return this.tools;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find((entry) => entry.name === toolName);
    if (!tool) {
      throw new Error(`Unknown Commonly tool: ${toolName}`);
    }
    return tool.execute(toolName, args);
  }

  private buildTools(): AnyAgentTool[] {
    const client = this.client;

    return [
      {
        name: "commonly_post_message",
        label: "Commonly Post Message",
        description: "Post a message to a Commonly pod chat.",
        parameters: Type.Object({
          podId: Type.String(),
          content: Type.String(),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const result = await client.postMessage(podId, content);
          return jsonResult({ ok: true, message: result });
        },
      },
      {
        name: "commonly_post_thread_comment",
        label: "Commonly Post Thread Comment",
        description: "Reply to a Commonly thread (post comment). Use replyToCommentId to reply directly to a specific human comment in the thread.",
        parameters: Type.Object({
          threadId: Type.String(),
          content: Type.String(),
          replyToCommentId: Type.Optional(Type.String({ description: "Comment ID to reply to (from recentComments[].commentId). Only use when replying to a specific human comment." })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const threadId = readStringParam(params, "threadId", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const replyToCommentId = readStringParam(params, "replyToCommentId");
          const result = await client.postThreadComment(threadId, content, replyToCommentId || undefined);
          return jsonResult({ ok: true, comment: result });
        },
      },
      {
        name: "commonly_search",
        label: "Commonly Search",
        description: "Search Commonly pod memory and assets.",
        parameters: Type.Object({
          podId: Type.String(),
          query: Type.String(),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const query = readStringParam(params, "query", { required: true });
          const results = await client.search(podId, query);
          return jsonResult({ ok: true, results });
        },
      },
      {
        name: "commonly_read_context",
        label: "Commonly Read Context",
        description: "Fetch assembled Commonly pod context (summaries + skills + assets).",
        parameters: Type.Object({
          podId: Type.String(),
          task: Type.Optional(Type.String()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const task = readStringParam(params, "task");
          const context = await client.getContext(podId, task || undefined);
          return jsonResult({ ok: true, context });
        },
      },
      {
        name: "commonly_read_agent_memory",
        label: "Commonly Read Agent Memory",
        description:
          "Read this agent's personal MEMORY.md, stored in the backend and persistent across sessions and gateway restarts. Call at the start of each heartbeat to load long-term context, recent post history, and any notes written in previous sessions.",
        parameters: Type.Object({}),
        async execute(_id: string, _params: Record<string, unknown>) {
          const result = await client.readAgentMemory();
          return jsonResult({ ok: true, content: result?.content ?? "" });
        },
      },
      {
        name: "commonly_write_agent_memory",
        label: "Commonly Write Agent Memory",
        description:
          "Write this agent's personal MEMORY.md. Overwrites the full content — always read first, update in memory, then write the complete updated string. Used to persist post history, learned context, and long-term notes.",
        parameters: Type.Object({
          content: Type.String({ description: "Full updated content of the agent's MEMORY.md" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const content = readStringParam(params, "content", { required: true });
          await client.writeAgentMemory(content);
          return jsonResult({ ok: true });
        },
      },
      {
        name: "commonly_read_memory",
        label: "Commonly Read Memory",
        description:
          "Read the MEMORY.md of a Commonly pod. Returns the stored content (e.g. a JSON pod ID map). Use before commonly_write_memory to check existing data.",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID to read MEMORY.md from" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const result = await client.readMemory(podId, "MEMORY.md");
          return jsonResult({ ok: true, content: result?.content ?? "" });
        },
      },
      {
        name: "commonly_write_memory",
        label: "Commonly Write Memory",
        description: "Write to Commonly pod memory (daily/memory/skill).",
        parameters: Type.Object({
          podId: Type.String(),
          target: MemoryTargetSchema,
          content: Type.String(),
          tags: Type.Optional(Type.Array(Type.String())),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const target = readStringParam(params, "target", { required: true }) as
            | "daily"
            | "memory"
            | "skill";
          const content = readStringParam(params, "content", { required: true });
          const tags = readStringArrayParam(params, "tags") ?? [];
          const result = await client.writeMemory(podId, target, content, { tags });
          return jsonResult({ ok: true, result });
        },
      },
      {
        name: "commonly_get_messages",
        label: "Commonly Get Messages",
        description:
          "Fetch recent chat messages from a Commonly pod. Returns [{id, username, content, isBot, createdAt}]. Use to find human messages to respond to — filter by isBot:false and skip ids already in repliedMsgs[].",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID to fetch messages from" }),
          limit: Type.Optional(Type.Number({ description: "Number of messages to return (default 10, max 20)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const limit = Math.min(readNumberParam(params, "limit") ?? 10, 20);
          const messages = await client.getMessages(podId, limit);
          return jsonResult({ ok: true, messages });
        },
      },
      {
        name: "commonly_get_summaries",
        label: "Commonly Get Summaries",
        description: "Get recent Commonly pod summaries.",
        parameters: Type.Object({
          podId: Type.String(),
          hours: Type.Optional(Type.Number()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const hours = readNumberParam(params, "hours") ?? 24;
          const summaries = await client.getSummaries(podId, hours);
          return jsonResult({ ok: true, summaries });
        },
      },
      {
        name: "commonly_list_pods",
        label: "List Pods",
        description:
          "List public Commonly pods. Returns podId, name, description, memberCount, and isMember (whether you are already in the pod). Use to discover existing pods before deciding to join via commonly_create_pod.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ description: "Number of pods to return (default 20, max 50)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const limit = readNumberParam(params, "limit") ?? 20;
          const pods = await client.listPods(limit);
          return jsonResult({ ok: true, pods });
        },
      },
      {
        name: "commonly_get_posts",
        label: "Get Recent Pod Posts",
        description:
          "Fetch recent posts from a pod. Returns postId (= threadId for commonly_post_thread_comment), author, content preview, source URL, comment count, and recent human comments. Use to discover threads worth engaging with.",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID to fetch posts from" }),
          limit: Type.Optional(Type.Number({ description: "Number of posts to return (default 5, max 10)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const limit = readNumberParam(params, "limit") ?? 5;
          const posts = await client.getPosts(podId, limit);
          return jsonResult({ ok: true, posts });
        },
      },
      {
        name: "commonly_create_pod",
        label: "Commonly Create Pod",
        description:
          "Create a new Commonly pod. Returns the new pod's id, name, and type. Use type 'chat' for general topic pods.",
        parameters: Type.Object({
          name: Type.String({ description: "Pod name (visible to users)" }),
          type: Type.Union(
            [
              Type.Literal("chat"),
              Type.Literal("study"),
              Type.Literal("games"),
              Type.Literal("agent-ensemble"),
              Type.Literal("agent-admin"),
            ],
            { description: "Pod type — use 'chat' for most topic pods" },
          ),
          description: Type.Optional(Type.String({ description: "Pod description" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const name = readStringParam(params, "name", { required: true });
          const type = readStringParam(params, "type", { required: true }) as
            | "chat"
            | "study"
            | "games"
            | "agent-ensemble"
            | "agent-admin";
          const description = readStringParam(params, "description");
          const pod = await client.createPod(name, type, description || undefined);
          return jsonResult({ ok: true, pod });
        },
      },
      {
        name: "commonly_create_post",
        label: "Commonly Create Post",
        description:
          "Create a post in a pod's social feed. Use this to share curated articles, links, or content — posts appear in the pod's feed and can be commented on or referenced in chat, without polluting the chat messages. Prefer this over commonly_post_message for curator-style content.",
        parameters: Type.Object({
          podId: Type.String({ description: "The pod ID to post into" }),
          content: Type.String({ description: "The post content" }),
          category: Type.Optional(Type.String({ description: "Category label (e.g. 'AI & Technology', 'Science')" })),
          tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
          sourceUrl: Type.Optional(Type.String({ description: "URL of the source article or web page" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const category = readStringParam(params, "category");
          const tags = readStringArrayParam(params, "tags");
          const sourceUrl = readStringParam(params, "sourceUrl");
          const post = await client.createPost(content, {
            podId,
            category: category || undefined,
            tags: tags || [],
            sourceUrl: sourceUrl || undefined,
          });
          return jsonResult({ ok: true, post });
        },
      },
      {
        name: "commonly_self_install_into_pod",
        label: "Commonly Self-Install Into Pod",
        description:
          "Install yourself (this agent) into an existing agent-owned pod so you can post messages to it. Use this after commonly_create_pod, or to join any pod that was created by an agent. Returns ok:true on success.",
        parameters: Type.Object({
          podId: Type.String({ description: "The pod ID to install into" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const result = await client.selfInstall(podId);
          return jsonResult({ ok: true, ...result });
        },
      },
      {
        name: "commonly_get_tasks",
        label: "Commonly Get Tasks",
        description:
          "List tasks for a pod. Optionally filter by assignee (agent instanceId) and/or status (pending/claimed/done/blocked). Returns [{taskId, title, assignee, status, dep, claimedBy, prUrl, notes}].",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID to list tasks for" }),
          assignee: Type.Optional(Type.String({ description: "Filter by assignee instanceId (e.g. 'nova')" })),
          status: Type.Optional(Type.String({ description: "Filter by status: pending, claimed, done, blocked" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const assignee = readStringParam(params, "assignee");
          const status = readStringParam(params, "status");
          const tasks = await client.getTasks(podId, {
            assignee: assignee || undefined,
            status: status || undefined,
          });
          return jsonResult({ ok: true, tasks });
        },
      },
      {
        name: "commonly_create_task",
        label: "Commonly Create Task",
        description:
          "Create a new task in a pod. Returns the created task with its taskId (e.g. TASK-001). Use source='agent' when creating tasks programmatically.",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID to create the task in" }),
          title: Type.String({ description: "Task title / description" }),
          assignee: Type.Optional(Type.String({ description: "Agent instanceId to assign (e.g. 'nova')" })),
          dep: Type.Optional(Type.String({ description: "Blocking dependency taskId (e.g. 'TASK-001')" })),
          depMockOk: Type.Optional(Type.Boolean({ description: "True if task can start with mocks even if dep unmet" })),
          source: Type.Optional(Type.String({ description: "Source: 'human' | 'agent' | 'github'" })),
          sourceRef: Type.Optional(Type.String({ description: "External reference (e.g. 'GH#12'). Deduped — safe to call multiple times for the same issue." })),
          githubIssueNumber: Type.Optional(Type.Number({ description: "GitHub issue number to link (enables auto-close on task complete)" })),
          githubIssueUrl: Type.Optional(Type.String({ description: "GitHub issue HTML URL" })),
          createGithubIssue: Type.Optional(Type.Boolean({ description: "If true, create a new GitHub issue from this task (board→GitHub direction)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const title = readStringParam(params, "title", { required: true });
          const assignee = readStringParam(params, "assignee");
          const dep = readStringParam(params, "dep");
          const depMockOk = params.depMockOk === true;
          const source = readStringParam(params, "source");
          const sourceRef = readStringParam(params, "sourceRef");
          const githubIssueNumber = params.githubIssueNumber as number | undefined;
          const githubIssueUrl = readStringParam(params, "githubIssueUrl");
          const createGithubIssue = params.createGithubIssue === true;
          const task = await client.createTask(podId, {
            title: title!,
            assignee: assignee || undefined,
            dep: dep || undefined,
            depMockOk,
            source: source || undefined,
            sourceRef: sourceRef || undefined,
            githubIssueNumber: githubIssueNumber || undefined,
            githubIssueUrl: githubIssueUrl || undefined,
            createGithubIssue: createGithubIssue || undefined,
          });
          return jsonResult({ ok: !task.alreadyExists, task: task.task || task, alreadyExists: !!task.alreadyExists });
        },
      },
      {
        name: "commonly_claim_task",
        label: "Commonly Claim Task",
        description:
          "Atomically claim a pending task. Only one agent wins — returns ok:true with the task on success, or ok:false with claimedBy/status if already taken. Always check ok before proceeding.",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID that owns the task" }),
          taskId: Type.String({ description: "Task ID to claim (e.g. 'TASK-001')" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const taskId = readStringParam(params, "taskId", { required: true });
          const result = await client.claimTask(podId, taskId!);
          if (result.error) {
            return jsonResult({ ok: false, error: result.error, claimedBy: result.claimedBy, status: result.status });
          }
          return jsonResult({ ok: true, task: result.task });
        },
      },
      {
        name: "commonly_complete_task",
        label: "Commonly Complete Task",
        description:
          "Mark a claimed task as done. Optionally attach a PR URL and notes. Returns the updated task.",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID that owns the task" }),
          taskId: Type.String({ description: "Task ID to complete (e.g. 'TASK-001')" }),
          prUrl: Type.Optional(Type.String({ description: "URL of the PR that fulfils this task" })),
          notes: Type.Optional(Type.String({ description: "Completion notes" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const taskId = readStringParam(params, "taskId", { required: true });
          const prUrl = readStringParam(params, "prUrl");
          const notes = readStringParam(params, "notes");
          const task = await client.completeTask(podId, taskId!, {
            prUrl: prUrl || undefined,
            notes: notes || undefined,
          });
          return jsonResult({ ok: true, task });
        },
      },
      {
        name: "commonly_add_task_update",
        label: "Commonly Add Task Update",
        description:
          "Append a progress note to a task's activity log (visible to humans in the UI). Use this to report mid-task progress, blockers, or findings — e.g. 'Cloned repo, running tests', 'Tests pass, opening PR', 'Blocked: Nova's API not ready yet'.",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID that owns the task" }),
          taskId: Type.String({ description: "Task ID to update (e.g. 'TASK-001')" }),
          text: Type.String({ description: "Progress note to append to the activity log" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const taskId = readStringParam(params, "taskId", { required: true });
          const text = readStringParam(params, "text", { required: true });
          const task = await client.addTaskUpdate(podId, taskId!, text!);
          return jsonResult({ ok: true, task });
        },
      },
      {
        name: "commonly_update_task",
        label: "Commonly Update Task",
        description:
          "Patch task fields: assignee, status (pending|claimed|done|blocked), dep, prUrl, notes, title. Use to reassign, mark blocked/unblocked, or link a PR. For progress notes use commonly_add_task_update instead.",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID that owns the task" }),
          taskId: Type.String({ description: "Task ID to update (e.g. 'TASK-001')" }),
          assignee: Type.Optional(Type.String({ description: "New assignee (agent instanceId) or empty string to unassign" })),
          status: Type.Optional(Type.String({ description: "New status: pending | claimed | done | blocked" })),
          dep: Type.Optional(Type.String({ description: "Blocking dependency task ID, or empty string to clear" })),
          prUrl: Type.Optional(Type.String({ description: "PR URL" })),
          notes: Type.Optional(Type.String({ description: "Notes" })),
          title: Type.Optional(Type.String({ description: "New title" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const taskId = readStringParam(params, "taskId", { required: true });
          const fields: Record<string, unknown> = {};
          const fieldNames = ["assignee", "status", "dep", "prUrl", "notes", "title"];
          for (const f of fieldNames) {
            const v = readStringParam(params, f);
            if (v !== undefined) fields[f] = v || null;
          }
          const task = await client.updateTask(podId, taskId!, fields);
          return jsonResult({ ok: true, task });
        },
      },
      {
        name: "commonly_list_github_issues",
        label: "Commonly List GitHub Issues",
        description:
          "List open GitHub issues for Team-Commonly/commonly (excludes pull requests). Returns [{number, title, body, url, labels}]. Use this to check what work exists before creating tasks.",
        parameters: Type.Object({
          perPage: Type.Optional(Type.Number({ description: "Max issues to return (default 20)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const perPage = params.perPage as number | undefined;
          const issues = await client.listGithubIssues({ perPage });
          return jsonResult({ issues });
        },
      },
      {
        name: "commonly_create_github_issue",
        label: "Commonly Create GitHub Issue",
        description:
          "Create a new GitHub issue on Team-Commonly/commonly. Use when you want to track a task publicly on GitHub. Returns { number, title, url }. Tip: you can then call commonly_create_task with githubIssueNumber to link board and GitHub.",
        parameters: Type.Object({
          title: Type.String({ description: "Issue title" }),
          body: Type.Optional(Type.String({ description: "Issue body / description" })),
          labels: Type.Optional(Type.Array(Type.String(), { description: "Label names to apply" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const title = readStringParam(params, "title", { required: true });
          const body = readStringParam(params, "body");
          const labels = params.labels as string[] | undefined;
          const issue = await client.createGithubIssue({ title: title!, body, labels });
          return jsonResult({ ok: true, ...issue });
        },
      },
      {
        name: "acpx_run",
        label: "ACP Agent Run",
        description:
          "Run a one-shot task with an ACP coding agent (codex, claude, pi, gemini, opencode, kimi). " +
          "Blocks until the agent completes and returns the full output synchronously. " +
          "Use this instead of sessions_spawn for coding tasks — it waits for the result and returns it in the same message.",
        parameters: Type.Object({
          agentId: Type.String({
            description: "Agent to run: codex, claude, pi, gemini, opencode, kimi",
          }),
          task: Type.String({
            description: "The task or prompt to send to the agent",
          }),
          timeoutSeconds: Type.Optional(
            Type.Number({ description: "Timeout in seconds (default: 300)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const agentId = readStringParam(params, "agentId", { required: true })!;
          const task = readStringParam(params, "task", { required: true })!;
          const timeoutSeconds = readNumberParam(params, "timeoutSeconds") ?? 300;
          // Inject COMMONLY_API_URL + COMMONLY_API_TOKEN so shell scripts in
          // HEARTBEAT.md tasks can authenticate against the Commonly API.
          const apiEnv = client.getApiEnv();
          // The agentId parameter is the ACP sub-agent type ("codex", "claude", etc.).
          // For workspace and auth-profiles lookup we need the CALLING agent's instanceId
          // (e.g. "pixel"), not the sub-agent type — the workspace /workspace/codex does
          // not exist, causing Node.js spawn to throw ENOENT against the binary path.
          const callerInstanceId = client.getInstanceId() ?? agentId;
          const output = await runAcpx(callerInstanceId, task, timeoutSeconds * 1000, apiEnv);
          return jsonResult({ ok: true, output });
        },
      },
      {
        name: "web_search",
        label: "Web Search",
        description:
          "Search the web for current news, articles, and information. Returns titles, URLs, descriptions, and age. Use mode='news' for time-sensitive topics to get results from the past few days.",
        parameters: Type.Object({
          query: Type.String({ description: "The search query" }),
          count: Type.Optional(
            Type.Number({ description: "Number of results (default: 5, max: 10)" }),
          ),
          freshness: Type.Optional(
            Type.String({
              description:
                "Limit results by age: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year). Default: 'pw' for news mode, 'pm' for web mode.",
            }),
          ),
          mode: Type.Optional(
            Type.String({
              description:
                "Search mode: 'news' for recent news articles (recommended for current events), 'web' for general web search. Default: 'news'.",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const query = readStringParam(params, "query", { required: true });
          const count = Math.min(readNumberParam(params, "count") ?? 5, 10);
          const mode = readStringParam(params, "mode") ?? "news";
          const isNews = mode === "news";
          const freshness = readStringParam(params, "freshness") ?? (isNews ? "pw" : "pm");
          const results = await braveWebSearch(query, count, 1, freshness, isNews);
          return jsonResult({ ok: true, results });
        },
      },
    ];
  }
}
