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
  type: 'mention' | 'heartbeat' | 'task.assigned' | 'chat.message' | 'pod.join' | 'first_contact' | 'manual';
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
// Free-tier default for the native runtime. Per-installation config can
// override (`installation.config.model`) for dev agents that legitimately
// need paid Codex — but the platform-wide default never burns Codex quota
// just because someone forgot to set the field.
const DEFAULT_MODEL = 'openrouter/nvidia/nemotron-3-super-120b-a12b:free';
const LITELLM_TIMEOUT_MS = Number(process.env.NATIVE_RUNTIME_TIMEOUT_MS) || 45_000;

// Guardrail opt-in for the native cloud-agent inference path. Unlike dev agents
// (Cody/Theo — separate runtimes, own keys, coding prompts, deliberately NOT
// guarded), the native runtime processes UNTRUSTED input: a public user conversing
// with a native agent, and pod content re-processed by first-party apps
// (welcomer/summarizer). Both are the indirect/direct prompt-injection surface once
// registration is public, so this path opts into the same enforce guardrails as
// llmService. These guardrails are default_on:false in litellm-config, so ONLY
// callers that send this field get them. Env-overridable (comma-separated; empty
// string disables) as a no-redeploy off-switch if it over-blocks a first-party app
// — a backend env change + pod restart, no image build. See
// docs/runbooks/litellm-guardrails.md.
const NATIVE_RUNTIME_GUARDRAILS = (
  process.env.NATIVE_RUNTIME_GUARDRAILS ?? 'openai-moderation-enforce,injection-guard'
).split(',').map((s) => s.trim()).filter(Boolean);

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
  {
    type: 'function',
    function: {
      name: 'commonly_propose_action',
      description:
        'Propose an action that needs the workspace owner\'s approval. Posts an '
        + 'approval card to the pod; the action runs only if the owner approves. '
        + 'Use for anything that creates a surface others can see or join — '
        + 'create_pod (a new pod), connect_local_agent (a seat for an agent that '
        + 'runs on the user\'s own machine; after approval the user links it from '
        + 'the connect page — you never see or handle its token). Do NOT also '
        + 'post a separate chat message about the proposal; the card IS the message.',
      parameters: {
        type: 'object',
        properties: {
          actionType: {
            type: 'string',
            enum: ['create_pod', 'connect_local_agent'],
            description: 'The action being proposed',
          },
          summary: {
            type: 'string',
            description: 'One sentence, in the user\'s language: what will happen if they approve',
          },
          params: {
            type: 'object',
            description: 'Action parameters. For create_pod: { name (required), description?, '
              + 'type? ("chat"|"team") }. For connect_local_agent: { name (required — '
              + 'lowercase letters/digits/dashes, e.g. "sams-claude") }',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              type: { type: 'string', enum: ['chat', 'team'] },
            },
          },
        },
        required: ['actionType', 'summary', 'params'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commonly_agent_status',
      description:
        'Check the connection status of every agent installed in this pod. '
        + 'Returns each agent\'s runtime kind and state: active (seen in the last '
        + '10 minutes), idle (last day), stale (silent for over a day), '
        + 'never-connected (a local/BYO seat whose runtime has never '
        + 'authenticated — the user still needs to link it from the connect '
        + 'page), or ready (a native agent; it runs when addressed and has no '
        + 'connection to make). Use this to answer "is my agent connected?".',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ADR-020 D1: the manifest's `tools` list is the capability boundary, and it
// must be ENFORCED here, not just declared. Before this filter, TOOLS went
// unfiltered to every native agent — the allowlist in each agent definition
// was decorative (caught in the 2026-08-13 build recon). Installs that
// predate tool lists (no cfg.tools) keep the pre-gate surface minus
// approval proposing, which is opt-in by declaration only.
export const toolsForConfig = (cfg: { tools?: unknown } | null | undefined): typeof TOOLS => {
  const declared = Array.isArray(cfg?.tools) ? (cfg?.tools as string[]) : null;
  if (!declared) {
    return TOOLS.filter((t) => t.function.name !== 'commonly_propose_action');
  }
  return TOOLS.filter((t) => declared.includes(t.function.name));
};

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
        // ADR-003 Phase 2: clear /memory/sync dedup cache when a non-sync
        // writer mutates the doc, so the next sync promotion isn't wrongly
        // short-circuited on a stale hash.
        await AgentMemory.findOneAndUpdate(
          { agentName: ctx.agentName, instanceId: ctx.instanceId },
          { $set: { content: nextContent }, $unset: { lastSyncKey: '', lastSyncAt: '' } },
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

      case 'commonly_propose_action': {
        // ADR-020 D1/D3: outward-visible actions go through an approval card.
        // proposeAction validates, creates the ApprovalAction row, and posts
        // the card message itself — the tool-loop marks postedViaTool so the
        // fallback never double-posts narration beside the card.
        const { proposeAction } = require('./approvalActionService');
        const result = await proposeAction({
          podId: String(ctx.podId),
          agentName: ctx.agentName,
          instanceId: ctx.instanceId,
          displayName: ctx.displayName,
          actionType: String(args.actionType || ''),
          params: (args.params && typeof args.params === 'object'
            ? args.params : {}) as Record<string, unknown>,
          summary: String(args.summary || ''),
          installationConfig: ctx.installationConfig,
        });
        if (!result.ok) {
          return { content: { ok: false, error: result.error }, error: 'propose_failed' };
        }
        return {
          content: {
            ok: true,
            proposed: true,
            approvalId: result.approvalId,
            note: 'Approval card posted. The action runs only if the owner approves — do not post another message about it.',
          },
        };
      }

      case 'commonly_agent_status': {
        // One derivation, shared with the pod-agents roster route — the
        // Raft-comparison P4 rule: never fork status vocabulary per surface.
        const { AgentInstallation } = require('../models/AgentRegistry');
        const { collectPodAgentActivity, deriveActivityBucket } = require('./agentStateService');
        const installations = await AgentInstallation.find({
          podId: ctx.podId,
          status: 'active',
        }).select('agentName instanceId displayName config').lean();
        const activity = await collectPodAgentActivity(String(ctx.podId), installations);
        const agents = (installations as Array<Record<string, any>>).map((i) => {
          const key = `${i.agentName}:${i.instanceId || 'default'}`;
          const lastActiveAt = activity.get(key) || null;
          const runtimeType = String(i.config?.runtime?.runtimeType || '') || 'unknown';
          return {
            name: i.displayName || i.agentName,
            agentName: i.agentName,
            runtime: runtimeType,
            state: deriveActivityBucket(lastActiveAt, runtimeType),
            lastActiveAt: lastActiveAt ? new Date(lastActiveAt).toISOString() : null,
          };
        });
        return { content: { agents } };
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

  if (trigger.type === 'first_contact') {
    const content = String(payload.content || '').trim();
    return content || 'A human just added you to this workspace. Post a short, warm greeting that ends with one specific question.';
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
  if (raw === 'first_contact') return 'first_contact';
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

  // D4 cost ceiling: per-installation daily run cap, enforced before any
  // claim or model work. The Guide runs on a paid model in every new user's
  // workspace — bounded by construction, not by hope. Count failure fails
  // OPEN (#887's shape: an infrastructure fault must not silence an agent);
  // only an actual at-cap count declines, loudly.
  const dailyRunCap = Number(cfg.dailyRunCap);
  if (Number.isFinite(dailyRunCap) && dailyRunCap > 0) {
    try {
      const AgentRunModel = require('../models/AgentRun');
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const runsToday = await AgentRunModel.countDocuments({
        podId: installation.podId,
        agentName,
        instanceId,
        startedAt: { $gte: dayStart },
      });
      if (runsToday >= dailyRunCap) {
        console.warn(
          `[native-runtime] ${agentName}:${instanceId} daily run cap (${dailyRunCap}) reached `
          + `in pod ${podId} — declining until UTC midnight`,
        );
        return {
          runId: '', status: 'succeeded', totalTurns: 0, totalTokens: 0,
        };
      }
    } catch (err) {
      console.warn('[native-runtime] daily-cap count failed — proceeding unguarded:', (err as Error).message);
    }
  }

  // ADR-022 D5 invariant: the per-user daily ceiling — keyed on installedBy,
  // summed across ALL the user's hosted installs. The per-install cap above
  // stays as the runaway-loop guard; this is the spend promise ("1 hosted
  // colleague included" needs a number that cannot silently multiply when a
  // user hires a second persona or places one in three rooms). Two deliberate
  // reversals from the cap above: the decline is TRUTHFUL (failed +
  // errorKind, never an empty success), and a count failure fails CLOSED —
  // a runaway guard and a spend ceiling have opposite safe directions.
  // Forward-only: rows without userId predate the stamp and cannot be
  // counted; the window inherits the cap's fixed-UTC-midnight semantics.
  const userCeiling = Number(process.env.AGENT_USER_DAILY_RUN_CEILING ?? 120);
  if (Number.isFinite(userCeiling) && userCeiling > 0) {
    const installedBy = installation.installedBy ? String(installation.installedBy) : '';
    if (!installedBy) {
      console.warn(
        `[native-runtime] ${agentName}:${instanceId} has no installedBy — `
        + 'per-user ceiling unenforceable for this install',
      );
    } else {
      try {
        const AgentRunModel = require('../models/AgentRun');
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const userRunsToday = await AgentRunModel.countDocuments({
          userId: installedBy,
          startedAt: { $gte: dayStart },
        });
        if (userRunsToday >= userCeiling) {
          console.warn(
            `[native-runtime] user ${installedBy} hit the per-user daily ceiling `
            + `(${userCeiling}) — declining ${agentName}:${instanceId} until UTC midnight`,
          );
          return failedResult('', 'user_ceiling', `per-user daily ceiling (${userCeiling}) reached`);
        }
      } catch (err) {
        return failedResult(
          '',
          'user_ceiling_check_failed',
          `per-user ceiling count failed (failing closed): ${(err as Error).message}`,
        );
      }
    }
  }

  // ADR-018 D3: native is one of OUR drivers — deterministic claim-before-act,
  // the same rule the CLI wrapper enforces (#894). Fleet audit (Sharpen msg
  // 53016) found this gap: the event queue pre-claims DELIVERY, but nothing
  // claimed the MESSAGE, so two concurrent native agents could both act on
  // one trigger. A lost CAS is a complete, silent stand-down — no AgentRun
  // row, deliberately: a stand-down is not an execution, and the acked event
  // carries the trace. Claim infrastructure failures fail OPEN (#887):
  // enforcement must never silence an agent on an infrastructure fault.
  // Raw-type gate mirrors the wrapper's claimable set (mention variants +
  // message-shaped wakes); heartbeat/task/join triggers carry no message.
  const CLAIMABLE_RAW_TYPES = new Set([
    'chat.mention', 'thread.mention', 'mention', 'chat.message', 'message.posted', 'dm.message',
  ]);
  const claimMessageId = CLAIMABLE_RAW_TYPES.has(String(trigger.type))
    ? String((trigger.payload as { messageId?: unknown } | null)?.messageId || '')
    : '';
  let claimHeld = false;
  if (claimMessageId) {
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const MessageClaimService = require('./messageClaimService');
      const claim = await MessageClaimService.claim({
        messageId: claimMessageId, podId, agentName, instanceId,
      });
      if (claim?.claimed) {
        claimHeld = true;
      } else if (claim) {
        console.log(
          `[native-runtime] ${agentName}:${instanceId} stood down — message ${claimMessageId} `
          + `claimed by ${claim.claimedBy || 'another agent'}`,
        );
        return {
          runId: '', status: 'succeeded', totalTurns: 0, totalTokens: 0,
        };
      }
    } catch (err) {
      console.warn('[native-runtime] claim unavailable — proceeding unguarded (#887):', (err as Error).message);
    }
  }

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
    // D5 denormalization: the per-user ceiling counts on this. Forward-only.
    userId: installation.installedBy ? String(installation.installedBy) : undefined,
    trigger: triggerType,
    triggerEventId: trigger.eventId || undefined,
    status: 'queued',
    turns: [],
    totalTokens: 0,
    startedAt: new Date(),
  });
  const runId = String(run._id);

  // Typing indicator — best-effort; stop guaranteed via emitStop() below.
  // The claim releases in the same cleanup: typing-stops and lease-release
  // are one moment (D7 — "someone's on it" ends when the turn ends), and
  // emitStop is already called on every terminal path of this function.
  const emitStop = () => {
    try {
      const typing = require('./agentTypingService');
      typing.emitAgentTypingStop({ podId, agentName, instanceId });
    } catch (err) {
      console.warn('[native-runtime] typing stop failed:', (err as Error).message);
    }
    if (claimHeld) {
      claimHeld = false;
      try {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const MessageClaimService = require('./messageClaimService');
        // Fire-and-forget: a miss just means the lease already lapsed.
        Promise.resolve(
          MessageClaimService.release({ messageId: claimMessageId, agentName, instanceId }),
        ).catch(() => {});
      } catch (err) {
        console.warn('[native-runtime] claim release failed:', (err as Error).message);
      }
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
            // ADR-020 D1: the manifest's tool allowlist, enforced.
            tools: toolsForConfig(cfg),
            tool_choice: 'auto',
            // Guard the untrusted-user / untrusted-pod-content surface (see the
            // NATIVE_RUNTIME_GUARDRAILS note above). Omitted entirely when empty
            // so an operator can disable via env without a redeploy.
            ...(NATIVE_RUNTIME_GUARDRAILS.length ? { guardrails: NATIVE_RUNTIME_GUARDRAILS } : {}),
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
          // A content guardrail (injection / moderation) rejection comes back as an
          // error status from LiteLLM. Tag it distinctly so it's observable in
          // AgentRun metrics (told apart from genuine LLM failures) and never
          // surfaces the raw proxy payload back to a possibly-malicious user.
          if (/guardrail|moderation|prompt-injection/i.test(bodyText)) {
            run.status = 'failed';
            run.errorKind = 'guardrail_blocked';
            run.errorMessage = 'Request blocked by a content guardrail (prompt-injection / moderation).';
            break;
          }
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
          // Proposing posts the card message itself — without this, the
          // fallback below would double-post the model's narration next to
          // the card (the exact double-post class commonly_post_message's
          // special case exists for).
          if (tc.function?.name === 'commonly_propose_action' && !result.error) {
            postedViaTool = true;
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
