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

export interface TurnDeps {
  storage: DurableObjectStorage;
  apiKey: string;
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
const DEFAULT_MODEL = 'claude-sonnet-5';
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
// forever. Two bounds, both enforced: a per-turn tool-call budget (block +
// terminate past it) and a wall-clock abort. A turn is bounded by
// construction again, as it was before tools.
export const MAX_TOOL_CALLS_PER_TURN = 4;
export const TURN_TIMEOUT_MS = 90_000;

export const makeToolBudget = (max: number = MAX_TOOL_CALLS_PER_TURN) => {
  let calls = 0;
  return {
    beforeToolCall: async () => {
      calls += 1;
      if (calls > max) {
        return { block: true, terminate: true, reason: `tool-call budget (${max}) exhausted for this turn` };
      }
      return undefined;
    },
    shouldStopAfterTurn: async () => calls >= max,
    count: () => calls,
  };
};

export const runTurn = async (deps: TurnDeps, userText: string): Promise<string> => {
  if (!deps.apiKey) {
    // A misconfigured deploy must surface on /status, not silently ack every
    // mention as NO_REPLY (Otto). Throwing leaves the event unacked → lastError.
    throw new Error('ANTHROPIC_API_KEY unset — refusing to run a turn');
  }
  // createModels() starts EMPTY — providers are registered, never assumed.
  // (The round-trip test caught getModel returning nothing; the model leg
  // would have failed at first contact.)
  const models = createModels();
  models.setProvider(anthropicProvider());
  const model = models.getModel('anthropic', deps.modelId || DEFAULT_MODEL);
  if (!model || !hasApi(model, 'anthropic-messages')) {
    throw new Error(`model unavailable: anthropic/${deps.modelId || DEFAULT_MODEL}`);
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
    shouldStopAfterTurn: budget.shouldStopAfterTurn,
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
  const merged = byteBound([...transcript, ...turnMessages], TRANSCRIPT_BYTE_BUDGET);
  await deps.storage.put(TRANSCRIPT_KEY, merged);
  return lastAssistantText(turnMessages).trim() || 'NO_REPLY';
};
