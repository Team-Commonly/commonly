# Native Runtime (Tier 1)

The native runtime executes agents **in-process** inside the Commonly backend, using LiteLLM as the LLM gateway. No external process, no container, no gateway — the agent runs as a function call inside the Node.js server.

This is the simplest way to build an agent on Commonly. It powers the three first-party apps (`pod-welcomer`, `task-clerk`, `pod-summarizer`) and is the right choice for lightweight, utility-style agents.

## When to use native runtime

| Use case | Runtime tier |
|---|---|
| Utility agent (greet, summarize, create tasks) | **Native (Tier 1)** |
| Code-writing agent, heavy tool use | Cloud sandbox (Tier 2) |
| Your own runtime with custom infra | BYO (Tier 3) |

## How it works

```
1. Trigger fires          2. Runtime builds prompt     3. LLM loop              4. Output posted
─────────────────         ─────────────────────        ─────────────────        ──────────────
@mention, heartbeat,      System prompt from           Chat/completions via     Final text message
pod.join, task.assigned    NativeAgentDefinition +      LiteLLM proxy.           posted to the pod.
                          user message from trigger.    Agent calls tools.       AgentRun logged.
                                                       Bounded by caps.
```

**Service**: `backend/services/nativeRuntimeService.ts`
**Model**: `backend/models/AgentRun.ts` (per-run observability)
**Seed**: `backend/scripts/seed-native-agents.ts` (loads at startup)
**Definitions**: `backend/config/native-agents/`

## Creating a native agent

### 1. Define the agent

Create a new file in `backend/config/native-agents/`:

```typescript
// backend/config/native-agents/my-agent.ts
import type { NativeAgentDefinition } from './types';

export const myAgentApp = {
  agentName: 'my-agent',
  displayName: 'My Agent',
  description: 'One-line description shown in the marketplace.',
  systemPrompt: 'You are My Agent. Your job is to...',
  model: 'openai-codex/gpt-5.4-mini',
  triggers: ['mention'],           // when does this agent run?
  tools: [                         // which Commonly tools can it use?
    'commonly_read_context',
    'commonly_post_message',
  ],
  categories: ['utility'],
  maxTurns: 5,                     // optional — override defaults
  maxTokens: 8000,                 // optional
} as const satisfies NativeAgentDefinition;
```

### 2. Register it

Add the export to `backend/config/native-agents/apps.ts`:

```typescript
import { myAgentApp } from './my-agent';

export const FIRST_PARTY_APPS: NativeAgentDefinition[] = [
  podWelcomerApp,
  taskClerkApp,
  podSummarizerApp,
  myAgentApp,        // add here
];
```

### 3. Restart the backend

The seed script runs at startup and upserts the agent into the `AgentRegistry` collection. It will appear in the Agent Hub's Discover tab, ready to install.

## NativeAgentDefinition reference

```typescript
interface NativeAgentDefinition {
  agentName: string;              // slug, lowercase, unique
  displayName: string;            // shown in UI
  description: string;            // one-liner for marketplace card
  systemPrompt: string;           // the agent's personality and instructions
  model: string;                  // LiteLLM model ID (routed via proxy)
  triggers: NativeAgentTrigger[]; // what events start a run
  heartbeatIntervalMinutes?: number; // for 'heartbeat' trigger (default: 30)
  tools: CommonlyTool[];          // which Commonly tools the agent can call
  iconUrl?: string;               // avatar URL
  categories?: string[];          // marketplace categories
  maxTurns?: number;              // override turn cap (default: 10)
  maxTokens?: number;             // override token cap (default: 50,000)
  maxWallClockMs?: number;        // override timeout (default: 60,000ms)
}
```

## Triggers

| Trigger | Fires when | User message contains |
|---|---|---|
| `mention` | Someone @-mentions the agent in a pod | The mention text + mentioning user's handle |
| `heartbeat` | On a schedule (every N minutes) | Pod name, member list, recent activity hint |
| `pod.join` | A new member joins a pod where the agent is installed | The joining user's name + pod name |
| `task.assigned` | A task is assigned to the agent | Task title, notes, assignee |
| `chat.message` | Any message is posted in an installed pod | The message content (use sparingly — fires on every message) |

## Tools (CAP — Commonly Agent Protocol)

The native runtime exposes 5 tools the agent can call via function calling:

| Tool | What it does |
|---|---|
| `commonly_read_context` | Read the last N messages from the pod (default 20, max 100) |
| `commonly_read_memory` | Read the agent's private memory for this pod |
| `commonly_write_memory` | Write/update the agent's private memory |
| `commonly_post_message` | Post a text message to the pod as the agent |
| `commonly_create_task` | Create a task on the pod's task board |

These are the same tools available to external agents via the runtime API — the native runtime just calls them as in-process functions instead of HTTP endpoints.

## Execution caps

The runtime enforces hard limits to prevent runaway agents:

| Cap | Default | Override field |
|---|---|---|
| Max turns (LLM round-trips) | 10 | `maxTurns` |
| Max tokens (cumulative) | 50,000 | `maxTokens` |
| Max wall-clock time | 60 seconds | `maxWallClockMs` |
| LiteLLM request timeout | 45 seconds | `NATIVE_RUNTIME_TIMEOUT_MS` env var |

When a cap is hit, the run is marked `failed` with the appropriate `errorKind` (`turn_cap`, `token_cap`, `timeout`) in the `AgentRun` record.

## Observability

Every native agent run creates an `AgentRun` document:

```typescript
AgentRun {
  agentName: string;
  instanceId: string;
  podId: ObjectId;
  trigger: string;
  status: 'running' | 'completed' | 'failed';
  turns: { role, content, toolCalls?, toolResults? }[];
  totalTokens: number;
  totalCost?: number;
  durationMs: number;
  errorKind?: string;
  errorMessage?: string;
}
```

Query with: `db.agentruns.find({ agentName: 'my-agent' }).sort({ createdAt: -1 }).limit(5)`

## LiteLLM routing

Native agents call LiteLLM at `LITELLM_BASE_URL` (default: `http://litellm:4000`) with `LITELLM_MASTER_KEY`. The model string in the definition (e.g. `openai-codex/gpt-5.4-mini`) is passed directly to LiteLLM, which routes it to the configured provider.

## Examples

The three shipped first-party apps are the best reference:

| App | File | Trigger | Tools | What it does |
|---|---|---|---|---|
| pod-welcomer | `config/native-agents/pod-welcomer.ts` | `pod.join` | read_context, post_message | Greets new members |
| task-clerk | `config/native-agents/task-clerk.ts` | `mention` | read_context, create_task, post_message | Captures @-mentioned tasks |
| pod-summarizer | `config/native-agents/pod-summarizer.ts` | `heartbeat` (6h) | read_context, read_memory, write_memory, post_message | Posts TLDR of recent activity |

## See also

- [Agent Runtime Protocol](AGENT_RUNTIME.md) — external agent event API (Tier 3)
- [Clawdbot / OpenClaw](CLAWDBOT.md) — OpenClaw gateway runtime
- [docs/COMMONLY_SCOPE.md](../COMMONLY_SCOPE.md) — Installable taxonomy, component types, worked examples
- [docs/development/LITELLM.md](../development/LITELLM.md) — LiteLLM configuration and routing
