// The turn engine: pi agent-core driven directly (runAgentLoop), with the
// transcript persisted on DO storage and pi's own compaction keeping it
// bounded. This is the ADR-021/023 engine landing in its production home.
//
// Transport: streamSimple (pi-ai's Anthropic provider — fetch-based,
// workerd-clean per the spike). Tools: CAP calls built per event (tools.ts).
// The reply is the final assistant text. Remaining named slice, same seam:
// pi's real compaction — Session-entry based (prepareCompaction takes
// Entry[], not AgentMessage[]), so it arrives with the Session layer. Until
// then the transcript is tail-bounded by pi's token estimate and a byte
// ceiling: honest, bounded, lossy only at the oldest end.
import {
  runAgentLoop,
  estimateContextTokens,
  type AgentMessage,
  type AgentContext,
  type AgentLoopConfig,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import { createModels, hasApi, type Message } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';

export type ModelProvider = 'anthropic' | 'deepseek';

export interface TurnDeps {
  storage: DurableObjectStorage;
  apiKey: string;
  // Which pi-ai provider the key belongs to. BYOK per instance; the operator
  // picks. DeepSeek is OpenAI-completions-shaped and cheap — the guide agent
  // already runs on it in the cluster.
  provider?: ModelProvider;
  modelId?: string;
  systemPrompt: string;
  // Injectable loop runner so the storage round-trip is testable without
  // faking pi's event stream (Otto's #1339 gate: the persistence contract
  // is where the blocker lived).
  loop?: typeof runAgentLoop;
  // CAP tools for this turn (built per event; see tools.ts).
  tools?: AgentTool<any>[];
  maxToolCalls?: number;
  timeoutMs?: number;
}

const TRANSCRIPT_KEY = 'transcript';
const DEFAULT_MODEL: Record<ModelProvider, string> = {
  anthropic: 'claude-sonnet-5',
  deepseek: 'deepseek-v4-flash',
};
const PROVIDER_API: Record<ModelProvider, string> = {
  anthropic: 'anthropic-messages',
  deepseek: 'openai-completions',
};
// DO storage caps a value at ~2 MiB on the SQLite backend (128 KiB on KV).
// A token budget alone is denominated wrong for that (Otto): bound bytes too.
export const TRANSCRIPT_BYTE_BUDGET = 1_000_000;

// Identity conversion: AgentMessage ⊇ Message; anything that is not a plain
// LLM message (custom agent messages) is dropped. Contract: never throws.
export const convertToLlm = (messages: AgentMessage[]): Message[] => messages.filter(
  (m): m is Message => m && typeof (m as { role?: unknown }).role === 'string'
    && ['user', 'assistant', 'toolResult'].includes(String((m as { role: string }).role)),
);

export const lastAssistantText = (messages: AgentMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== 'assistant') continue;
    const content = m.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((c) => (c && (c as { type?: string }).type === 'text' ? String((c as { text?: string }).text || '') : '')).join('');
    }
  }
  return '';
};

// Tail-bound the transcript to a token budget using pi's estimator, dropping
// from the oldest end at turn boundaries (the next user message) so a turn is
// never split. Always keeps at least the last two messages.
export const tailBound = (
  messages: AgentMessage[],
  budgetTokens: number,
  estimate: (m: AgentMessage[]) => number = (m) => estimateContextTokens(m).tokens,
): AgentMessage[] => {
  let out = messages;
  while (out.length > 2 && estimate(out) > budgetTokens) {
    const nextUser = out.findIndex((m, i) => i > 0 && (m as { role?: string }).role === 'user');
    out = nextUser > 0 ? out.slice(nextUser) : out.slice(1);
  }
  return out;
};

// Byte-bound after the token bound: drop oldest turns until the serialized
// transcript fits DO storage. Same turn-boundary rule, same floor of two.
export const byteBound = (messages: AgentMessage[], budgetBytes: number): AgentMessage[] => {
  let out = messages;
  while (out.length > 2 && JSON.stringify(out).length > budgetBytes) {
    const nextUser = out.findIndex((m, i) => i > 0 && (m as { role?: string }).role === 'user');
    out = nextUser > 0 ? out.slice(nextUser) : out.slice(1);
  }
  return out;
};

// Otto's #1340 blocker: with tools, pi's loop is while(hasMoreToolCalls)
// with no step cap — a model that keeps calling a tool loops on paid calls
// forever. Two bounds, both enforced: a per-turn tool-call budget (block
// past it so the model answers with what it has; terminate only a runaway)
// and a wall-clock abort. A turn is bounded by construction again.
export const MAX_TOOL_CALLS_PER_TURN = 4;
export const TURN_TIMEOUT_MS = 90_000;

// Budget semantics (Otto, #1340 round 2): exhausting the budget must send
// the model BACK TO ANSWER, never end the turn — a blocked call returns its
// reason as the tool result and the loop continues, so the model writes its
// reply with what it has. Only a runaway (still calling tools past the grace
// window) is terminated, and that surfaces as an error, not as silence.
export const makeToolBudget = (max: number = MAX_TOOL_CALLS_PER_TURN, grace = 2) => {
  let calls = 0;
  return {
    beforeToolCall: async () => {
      calls += 1;
      if (calls > max + grace) {
        return { block: true, terminate: true, reason: `tool-call budget (${max}) exhausted and the model kept calling — terminating` };
      }
      if (calls > max) {
        return { block: true, reason: `Tool-call budget (${max}) exhausted for this turn. Answer now with what you already have.` };
      }
      return undefined;
    },
    count: () => calls,
    runaway: () => calls > max + grace,
  };
};

export const runTurn = async (deps: TurnDeps, userText: string): Promise<string> => {
  if (!deps.apiKey) {
    // A misconfigured deploy must surface on /status, not silently ack every
    // mention as NO_REPLY (Otto). Throwing leaves the event unacked → lastError.
    throw new Error('model API key unset — refusing to run a turn');
  }
  // createModels() starts EMPTY — providers are registered, never assumed.
  // (The round-trip test caught getModel returning nothing; the model leg
  // would have failed at first contact.)
  const provider: ModelProvider = deps.provider || 'anthropic';
  const models = createModels();
  models.setProvider(provider === 'deepseek' ? deepseekProvider() : anthropicProvider());
  const modelId = deps.modelId || DEFAULT_MODEL[provider];
  const model = models.getModel(provider, modelId);
  if (!model || !hasApi(model, PROVIDER_API[provider] as never)) {
    throw new Error(`model unavailable: ${provider}/${modelId}`);
  }

  let transcript = (await deps.storage.get<AgentMessage[]>(TRANSCRIPT_KEY)) || [];

  const contextWindow = (model as { contextWindow?: number }).contextWindow || 200_000;
  transcript = tailBound(transcript, Math.floor(contextWindow * 0.6));

  const prompt: AgentMessage = { role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() } as AgentMessage;
  const context: AgentContext = { systemPrompt: deps.systemPrompt, messages: transcript, tools: deps.tools || [] };
  const budget = makeToolBudget(deps.maxToolCalls ?? MAX_TOOL_CALLS_PER_TURN);
  const config: AgentLoopConfig = {
    model,
    convertToLlm,
    getApiKey: () => deps.apiKey,
    beforeToolCall: budget.beforeToolCall,
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`turn exceeded ${TURN_TIMEOUT_MS}ms`)), deps.timeoutMs ?? TURN_TIMEOUT_MS);

  // runAgentLoop returns ONLY this turn's messages (prompts + replies), never
  // context.messages — so the transcript is APPENDED, not replaced (Otto's
  // #1339 blocker: the previous shape overwrote memory every turn).
  const loop = deps.loop || runAgentLoop;
  let turnMessages: AgentMessage[];
  try {
    turnMessages = await loop([prompt], context, config, () => {}, abort.signal, streamSimple);
  } finally {
    clearTimeout(timer);
  }
  const text = lastAssistantText(turnMessages).trim();
  // An empty answer is a FAILURE, never deliberate silence: the model says
  // NO_REPLY explicitly when it means it. Throwing leaves the event unacked
  // and puts the cause on /status (Otto: the missing-key bug in a new hat).
  // Persist on SUCCESS ONLY — a failed turn must not save its prompt, or
  // each redelivery appends a duplicate (Otto, round 3); the abort path
  // already persists nothing, so both failure modes now leave no residue.
  if (!text) {
    throw new Error(budget.runaway()
      ? `turn terminated: model exceeded tool budget (${budget.count()} calls)`
      : 'turn ended without assistant text');
  }
  const merged = byteBound([...transcript, ...turnMessages], TRANSCRIPT_BYTE_BUDGET);
  await deps.storage.put(TRANSCRIPT_KEY, merged);
  return text;
};
