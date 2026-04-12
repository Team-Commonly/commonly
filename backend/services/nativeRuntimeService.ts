/**
 * nativeRuntimeService
 *
 * Tier 1 "native" agent runtime — the entire agent loop runs in-process inside
 * the Commonly backend using LiteLLM as the LLM gateway. Designed as a
 * drop-in alternative to external runtimes (OpenClaw / webhook / claude-code /
 * managed-agents) for zero-setup installs.
 *
 * Entry point: `runAgent(installation, trigger)` — called fire-and-forget from
 * agentEventService.enqueue when the installation's runtimeType is 'native'.
 *
 * Each invocation:
 *   1. Creates an AgentRun row (status=queued → running → succeeded/failed)
 *   2. Builds a system + user message pair from the trigger
 *   3. Loops LiteLLM chat/completions with 5 Commonly tools, bounded by
 *      MAX_TURNS / MAX_TOKENS / MAX_WALL_CLOCK_MS
 *   4. Posts the final output back to the pod via AgentMessageService
 *   5. Records every turn (prompt/completion tokens, tool calls, elapsed time)
 *
 * Hard-coded safety caps (MVP). No per-agent budgets, no resume-after-restart,
 * no fancy observability. If a run crashes mid-flight it stays `running` in
 * the DB — a later sweep can flip it to `interrupted`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, global-require,
   @typescript-eslint/no-require-imports */

import axios, { AxiosError } from 'axios';

// --- public surface --------------------------------------------------------

export interface NativeRunTrigger {
  type: 'mention' | 'heartbeat' | 'task.assigned' | 'chat.message' | 'pod.join' | 'manual';
  eventId?: string;
  payload?: unknown;
}

export interface NativeRunResult {
  runId: string;
  status: 'succeeded' | 'failed';
  totalTurns: number;
  totalTokens: number;
  finalMessage?: string;
  errorKind?: string;
  errorMessage?: string;
}

// --- tuning constants ------------------------------------------------------

const MAX_TURNS = 10;
const MAX_TOKENS = 50_000;
const MAX_WALL_CLOCK_MS = 60_000;
const DEFAULT_MODEL = 'openai-codex/gpt-5.4-mini';
const LITELLM_TIMEOUT_MS = Number(process.env.NATIVE_RUNTIME_TIMEOUT_MS) || 45_000;

// --- helpers ---------------------------------------------------------------

type PlainConfig = Record<string, any>;

function normalizeConfig(config: unknown): PlainConfig {
  if (!config) return {};
  if (config instanceof Map) return Object.fromEntries(config.entries());
  return config as PlainConfig;
}

function resolveLiteLLM(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = (process.env.LITELLM_BASE_URL || '').trim().replace(/\/$/, '');
  const apiKey = (
    process.env.LITELLM_MASTER_KEY
    || process.env.LITELLM_API_KEY
    || ''
  ).trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

export function isNativeRuntimeAvailable(): boolean {
  return resolveLiteLLM() !== null;
}

// --- tool schema (exactly 5 tools, OpenAI function-calling format) --------

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'commonly_read_context',
      description:
        'Read recent messages from the current pod. Returns up to 50 messages with author and timestamp.',
      parameters: {
        type: 'object',
        properties: {
          messageCount: {
            type: 'number',
            description: 'Number of recent messages to fetch (max 50)',
            default: 20,
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commonly_read_memory',
      description:
        "Read the agent's long-term memory for this instance. Returns the full memory content.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commonly_write_memory',
      description:
        "Append a note to the agent's long-term memory. The note is added to existing memory with a timestamp.",
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The note to save' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commonly_post_message',
      description:
        'Post a chat message to the pod. This is how you respond to users. Use this for your final response.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Markdown-supported message content' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commonly_create_task',
      description: 'Create a task on the pod task board.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          assignee: { type: 'string', description: 'Optional assignee display name' },
          notes: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
];

// --- tool dispatcher -------------------------------------------------------

interface DispatchContext {
  installation: any;
  podId: string;
  agentName: string;
  instanceId: string;
  displayName: string;
  installationConfig: PlainConfig;
}

interface DispatchResult {
  content: unknown;
  error?: string;
}

async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, any>;

  try {
    switch (name) {
      case 'commonly_read_context': {
        const limit = Math.min(Number(args.messageCount) || 20, 50);
        const Message = require('../models/pg/Message');
        // PG Message.findByPodId returns an array of formatted messages. If
        // PG is unreachable we fall back to MongoDB via models/Message so the
        // tool still returns something usable instead of exploding the loop.
        let rows: Array<Record<string, unknown>> = [];
        try {
          rows = (await Message.findByPodId(String(ctx.podId), limit)) as Array<Record<string, unknown>>;
        } catch (pgError) {
          console.warn(
            '[native-runtime] commonly_read_context PG fetch failed, falling back to Mongo:',
            (pgError as Error).message,
          );
          const MongoMessage = require('../models/Message');
          const docs = await MongoMessage.find({ podId: ctx.podId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .populate('userId', 'username')
            .lean();
          rows = (docs as Array<Record<string, unknown>>).reverse();
        }

        const messages = rows.map((row) => {
          const user = (row.userId as Record<string, unknown> | undefined) || {};
          const author =
            (user.username as string)
            || (row.username as string)
            || 'unknown';
          return {
            author,
            content: String(row.content || ''),
            createdAt: row.createdAt || row.created_at || null,
          };
        });
        return { content: { messages } };
      }

      case 'commonly_read_memory': {
        const AgentMemory = require('../models/AgentMemory');
        const doc = await AgentMemory.findOne({
          agentName: ctx.agentName,
          instanceId: ctx.instanceId,
        }).lean();
        return { content: { content: (doc?.content as string) || '' } };
      }

      case 'commonly_write_memory': {
        const content = String(args.content || '').trim();
        if (!content) {
          return { content: { ok: false, error: 'content is required' }, error: 'missing_content' };
        }
        const AgentMemory = require('../models/AgentMemory');
        const existing = await AgentMemory.findOne({
          agentName: ctx.agentName,
          instanceId: ctx.instanceId,
        });
        const prior = (existing?.content as string) || '';
        const nextContent = `${prior}${prior ? '\n\n' : ''}[${new Date().toISOString()}] ${content}`;
        await AgentMemory.findOneAndUpdate(
          { agentName: ctx.agentName, instanceId: ctx.instanceId },
          { $set: { content: nextContent } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        return { content: { ok: true, written: true } };
      }

      case 'commonly_post_message': {
        const content = String(args.content || '').trim();
        if (!content) {
          return { content: { ok: false, error: 'content is required' }, error: 'missing_content' };
        }
        const AgentMessageService = require('./agentMessageService');
        const result = await AgentMessageService.postMessage({
          agentName: ctx.agentName,
          instanceId: ctx.instanceId,
          podId: ctx.podId,
          content,
          messageType: 'text',
          displayName: ctx.displayName,
          installationConfig: ctx.installationConfig,
          metadata: { source: 'native-runtime' },
        });
        return { content: { ok: true, posted: true, result } };
      }

      case 'commonly_create_task': {
        const title = String(args.title || '').trim();
        if (!title) {
          return { content: { ok: false, error: 'title is required' }, error: 'missing_title' };
        }
        const Task = require('../models/Task');
        // Count existing tasks in the pod to derive a taskNum — the Task
        // schema requires a unique (podId, taskId) tuple, so we mint a
        // collision-resistant id using taskNum + agentName.
        const existing = await Task.countDocuments({ podId: ctx.podId });
        const taskNum = existing + 1;
        const taskId = `N-${taskNum}-${ctx.agentName}-${Date.now().toString(36)}`;
        const created = await Task.create({
          podId: ctx.podId,
          taskNum,
          taskId,
          title,
          assignee: args.assignee ? String(args.assignee) : null,
          notes: args.notes ? String(args.notes) : null,
          status: 'pending',
          source: 'agent',
        });
        return {
          content: {
            ok: true,
            taskId: String(created.taskId),
            taskNum: created.taskNum,
            _id: String(created._id),
          },
        };
      }

      default:
        return {
          content: { ok: false, error: `unknown tool: ${name}` },
          error: 'unknown_tool',
        };
    }
  } catch (err) {
    const message = (err as Error).message || String(err);
    return {
      content: { ok: false, error: message },
      error: message,
    };
  }
}

// --- prompt builders -------------------------------------------------------

function buildSystemPrompt(installation: any, cfg: PlainConfig): string {
  if (typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.trim()) {
    return cfg.systemPrompt;
  }
  const displayName =
    (installation?.displayName as string)
    || (installation?.agentName as string)
    || 'Commonly Agent';
  return (
    `You are ${displayName}, an AI agent on Commonly. When @-mentioned, respond helpfully `
    + 'using the commonly_post_message tool. Keep responses short and friendly.'
  );
}

function buildUserMessage(
  trigger: NativeRunTrigger,
  podName: string,
): string {
  const payload = (trigger.payload && typeof trigger.payload === 'object'
    ? trigger.payload as Record<string, any>
    : {}) as Record<string, any>;

  if (trigger.type === 'mention') {
    const user = String(payload.username || payload.userId || 'someone');
    const text = String(payload.content || payload.text || '').trim();
    return (
      `User @${user} mentioned you in pod ${podName}: "${text}". `
      + 'Call commonly_read_context if you need more history, then call '
      + 'commonly_post_message with your reply.'
    );
  }

  if (trigger.type === 'heartbeat') {
    return (
      `Periodic heartbeat at ${new Date().toISOString()}. The pod is ${podName}. `
      + 'Use commonly_read_context to see recent activity, decide if anything needs '
      + 'your attention, and call commonly_post_message if appropriate. Otherwise do nothing.'
    );
  }

  return (
    `Trigger: ${trigger.type}. Use commonly_read_context to understand what's happening, `
    + 'then respond or act as appropriate.'
  );
}

// --- the loop --------------------------------------------------------------

interface LiteLLMChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason?: string;
}

interface LiteLLMResponse {
  choices?: LiteLLMChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  _hidden_params?: { call_id?: string };
}

function extractCallId(data: LiteLLMResponse, headers: Record<string, unknown>): string | undefined {
  const hidden = data?._hidden_params?.call_id;
  if (hidden) return String(hidden);
  const headerId = (headers?.['x-litellm-call-id'] || headers?.['X-LiteLLM-Call-Id']) as
    | string
    | undefined;
  return headerId ? String(headerId) : undefined;
}

function mapTriggerType(raw: string): NativeRunTrigger['type'] {
  if (raw === 'chat.mention' || raw === 'thread.mention' || raw === 'mention') return 'mention';
  if (raw === 'heartbeat') return 'heartbeat';
  if (raw === 'task.assigned') return 'task.assigned';
  if (raw === 'chat.message') return 'chat.message';
  if (raw === 'pod.join') return 'pod.join';
  return 'manual';
}

function failedResult(
  runId: string,
  errorKind: string,
  errorMessage: string,
  totalTurns = 0,
  totalTokens = 0,
): NativeRunResult {
  return {
    runId,
    status: 'failed',
    totalTurns,
    totalTokens,
    errorKind,
    errorMessage,
  };
}

export async function runAgent(
  installation: any,
  trigger: NativeRunTrigger,
): Promise<NativeRunResult> {
  // Preconditions — never throw; callers fire-and-forget.
  if (!isNativeRuntimeAvailable()) {
    return failedResult(
      '',
      'config',
      'LiteLLM is not configured (LITELLM_BASE_URL + LITELLM_MASTER_KEY/LITELLM_API_KEY required)',
    );
  }
  if (!installation || !installation.podId || !installation.agentName) {
    return failedResult('', 'config', 'installation missing podId or agentName');
  }

  const cfg = normalizeConfig(installation.config);
  const runtimeCfg = normalizeConfig(cfg.runtime);
  const runtimeType = String(runtimeCfg.runtimeType || '').toLowerCase();
  if (runtimeType !== 'native') {
    return failedResult(
      '',
      'config',
      `runtimeType is '${runtimeType || 'unset'}', expected 'native'`,
    );
  }

  const podId = String(installation.podId);
  const agentName = String(installation.agentName || '').toLowerCase();
  const instanceId = String(installation.instanceId || 'default');
  const displayName = String(
    installation.displayName || agentName,
  );

  // Best-effort pod name lookup for user-message framing. Never block on it.
  let podName = 'this pod';
  try {
    const Pod = require('../models/Pod');
    const pod = await Pod.findById(installation.podId).lean();
    if (pod?.name) podName = String(pod.name);
  } catch (err) {
    console.warn('[native-runtime] pod lookup failed:', (err as Error).message);
  }

  // Create the run row up-front so even a crash leaves a trail.
  const AgentRun = require('../models/AgentRun');
  const triggerType = mapTriggerType(trigger.type);
  const run = await AgentRun.create({
    podId: installation.podId,
    agentName,
    instanceId,
    trigger: triggerType,
    triggerEventId: trigger.eventId || undefined,
    status: 'queued',
    turns: [],
    totalTokens: 0,
    startedAt: new Date(),
  });
  const runId = String(run._id);

  // Typing indicator — best-effort; stop guaranteed via emitStop() below.
  const emitStop = () => {
    try {
      const typing = require('./agentTypingService');
      typing.emitAgentTypingStop({ podId, agentName, instanceId });
    } catch (err) {
      console.warn('[native-runtime] typing stop failed:', (err as Error).message);
    }
  };
  try {
    const typing = require('./agentTypingService');
    typing.emitAgentTypingStart({
      podId,
      agentName,
      instanceId,
      displayName,
    });
  } catch (err) {
    console.warn('[native-runtime] typing start failed:', (err as Error).message);
  }

  const dispatchCtx: DispatchContext = {
    installation,
    podId,
    agentName,
    instanceId,
    displayName,
    installationConfig: cfg,
  };

  const litellm = resolveLiteLLM();
  if (!litellm) {
    run.status = 'failed';
    run.errorKind = 'config';
    run.errorMessage = 'LiteLLM resolved to null at dispatch time';
    run.completedAt = new Date();
    await run.save();
    emitStop();
    return failedResult(runId, 'config', run.errorMessage);
  }

  const systemPrompt = buildSystemPrompt(installation, cfg);
  const userMessage = buildUserMessage(trigger, podName);
  const model = String(cfg.model || DEFAULT_MODEL);

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  run.status = 'running';
  await run.save();

  const startTime = Date.now();
  let finalMessage: string | undefined;
  let turnIndex = 0;
  let postedViaTool = false;

  try {
    // Bounded loop. Each iteration = one LiteLLM call + any tool dispatch.
    // Break on: no tool_calls (final assistant text), caps hit, or errors.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Cap checks — evaluate BEFORE issuing the next LLM call so we fail fast.
      if (turnIndex >= MAX_TURNS) {
        run.status = 'failed';
        run.errorKind = 'turn_cap';
        run.errorMessage = `exceeded MAX_TURNS (${MAX_TURNS})`;
        break;
      }
      if (run.totalTokens >= MAX_TOKENS) {
        run.status = 'failed';
        run.errorKind = 'token_cap';
        run.errorMessage = `exceeded MAX_TOKENS (${MAX_TOKENS})`;
        break;
      }
      if (Date.now() - startTime >= MAX_WALL_CLOCK_MS) {
        run.status = 'failed';
        run.errorKind = 'timeout';
        run.errorMessage = `exceeded MAX_WALL_CLOCK_MS (${MAX_WALL_CLOCK_MS}ms)`;
        break;
      }

      const turnStart = Date.now();
      let llmResponse: LiteLLMResponse;
      let responseHeaders: Record<string, unknown> = {};
      try {
        const axiosResp = await axios.post<LiteLLMResponse>(
          `${litellm.baseUrl}/chat/completions`,
          {
            model,
            messages,
            tools: TOOLS,
            tool_choice: 'auto',
          },
          {
            headers: {
              Authorization: `Bearer ${litellm.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: LITELLM_TIMEOUT_MS,
            validateStatus: () => true,
          },
        );
        if (axiosResp.status < 200 || axiosResp.status >= 300) {
          const body = axiosResp.data as unknown;
          const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
          throw new Error(`LiteLLM HTTP ${axiosResp.status}: ${bodyText.slice(0, 500)}`);
        }
        llmResponse = axiosResp.data;
        responseHeaders = (axiosResp.headers || {}) as Record<string, unknown>;
      } catch (err) {
        const axErr = err as AxiosError;
        run.status = 'failed';
        run.errorKind = 'llm_error';
        run.errorMessage = (axErr.message || String(err)).slice(0, 1000);
        break;
      }

      const choice = llmResponse.choices?.[0];
      const msg = choice?.message || {};
      const usage = llmResponse.usage || {};

      const turn = {
        turnIndex,
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        toolCalls: [] as Array<Record<string, unknown>>,
        llmResponseText: (msg.content as string | null) || undefined,
        elapsedMs: 0,
        liteLLMCallId: extractCallId(llmResponse, responseHeaders),
      };

      const toolCalls = msg.tool_calls || [];

      if (toolCalls.length > 0) {
        // Preserve the assistant message with tool_calls so the next turn's
        // tool response messages can reference tool_call_id.
        messages.push({
          role: 'assistant',
          content: msg.content ?? null,
          tool_calls: toolCalls,
        });

        for (const tc of toolCalls) {
          const toolStart = Date.now();
          let parsedArgs: unknown = {};
          try {
            parsedArgs = tc.function?.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch (parseErr) {
            parsedArgs = { _raw: tc.function?.arguments || '' };
          }
          const result = await dispatchTool(tc.function?.name || '', parsedArgs, dispatchCtx);
          const elapsed = Date.now() - toolStart;
          turn.toolCalls.push({
            name: tc.function?.name || '',
            args: parsedArgs,
            result: result.content,
            error: result.error,
            elapsedMs: elapsed,
          });
          if (tc.function?.name === 'commonly_post_message' && !result.error) {
            postedViaTool = true;
            finalMessage = typeof (parsedArgs as any)?.content === 'string'
              ? String((parsedArgs as any).content)
              : undefined;
          }
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result.content ?? { ok: !result.error }),
          });
        }

        turn.elapsedMs = Date.now() - turnStart;
        run.turns.push(turn);
        run.totalTokens += Number(usage.total_tokens || 0);
        await run.save();

        turnIndex += 1;
        continue; // run another LLM turn so the model can react to tool output
      }

      // No tool calls → treat msg.content as the final assistant response.
      turn.elapsedMs = Date.now() - turnStart;
      run.turns.push(turn);
      run.totalTokens += Number(usage.total_tokens || 0);

      const textOut = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (textOut && !postedViaTool) {
        // Fallback: the LLM wrote content WITHOUT calling commonly_post_message.
        // Post it anyway so the human actually sees a reply.
        try {
          const AgentMessageService = require('./agentMessageService');
          await AgentMessageService.postMessage({
            agentName,
            instanceId,
            podId,
            content: textOut,
            messageType: 'text',
            displayName,
            installationConfig: cfg,
            metadata: { source: 'native-runtime', fallback: true },
          });
          finalMessage = textOut;
        } catch (postErr) {
          run.errorMessage = (postErr as Error).message;
          run.errorKind = 'tool_error';
        }
      }

      run.status = run.status === 'running' ? 'succeeded' : run.status;
      break;
    }
  } catch (loopErr) {
    run.status = 'failed';
    run.errorKind = run.errorKind || 'unknown';
    run.errorMessage = (loopErr as Error).message?.slice(0, 1000) || 'unknown error';
  }

  run.completedAt = new Date();
  try {
    await run.save();
  } catch (saveErr) {
    console.error('[native-runtime] failed to persist AgentRun:', (saveErr as Error).message);
  }

  emitStop();

  return {
    runId,
    status: run.status === 'succeeded' ? 'succeeded' : 'failed',
    totalTurns: run.turns.length,
    totalTokens: run.totalTokens,
    finalMessage,
    errorKind: run.errorKind,
    errorMessage: run.errorMessage,
  };
}

export default {
  runAgent,
  isNativeRuntimeAvailable,
};

// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
