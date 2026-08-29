// The turn engine: pi agent-core driven directly (runAgentLoop), with the
// transcript persisted on DO storage and pi's own compaction keeping it
// bounded. This is the ADR-021/023 engine landing in its production home.
//
// v1 scope (deliberate): streamSimple as the transport (pi-ai's Anthropic
// provider — fetch-based, workerd-clean per the spike), no tools yet. The
// reply is the final assistant text. Two named next slices, neither of which
// changes this seam (transcript in, text out): CAP tools (read pod context,
// attach), and pi's real compaction — which is Session-entry based
// (prepareCompaction takes Entry[], not AgentMessage[]), so it arrives with
// the Session layer. Until then the transcript is tail-bounded by pi's own
// token estimate: honest, bounded, and lossy only at the oldest end.
import {
  runAgentLoop,
  estimateContextTokens,
  type AgentMessage,
  type AgentContext,
  type AgentLoopConfig,
} from '@earendil-works/pi-agent-core';
import { createModels, hasApi, type Message } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';

export interface TurnDeps {
  storage: DurableObjectStorage;
  apiKey: string;
  modelId?: string;
  systemPrompt: string;
}

const TRANSCRIPT_KEY = 'transcript';
const DEFAULT_MODEL = 'claude-sonnet-5';

// Identity conversion: AgentMessage ⊇ Message; anything that is not a plain
// LLM message (custom agent messages) is dropped. Contract: never throws.
const convertToLlm = (messages: AgentMessage[]): Message[] => messages.filter(
  (m): m is Message => m && typeof (m as { role?: unknown }).role === 'string'
    && ['user', 'assistant', 'toolResult'].includes(String((m as { role: string }).role)),
);

const lastAssistantText = (messages: AgentMessage[]): string => {
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

export const runTurn = async (deps: TurnDeps, userText: string): Promise<string> => {
  const models = createModels();
  const model = models.getModel('anthropic', deps.modelId || DEFAULT_MODEL);
  if (!model || !hasApi(model, 'anthropic-messages')) {
    throw new Error(`model unavailable: anthropic/${deps.modelId || DEFAULT_MODEL}`);
  }

  let transcript = (await deps.storage.get<AgentMessage[]>(TRANSCRIPT_KEY)) || [];

  // Tail-bound the transcript to ~60% of the window using pi's estimator,
  // dropping from the oldest end at turn boundaries (a user message).
  const contextWindow = (model as { contextWindow?: number }).contextWindow || 200_000;
  const budget = Math.floor(contextWindow * 0.6);
  while (transcript.length > 2 && estimateContextTokens(transcript).tokens > budget) {
    const nextUser = transcript.findIndex((m, i) => i > 0 && (m as { role?: string }).role === 'user');
    transcript = nextUser > 0 ? transcript.slice(nextUser) : transcript.slice(1);
  }

  const prompt: AgentMessage = { role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() } as AgentMessage;
  const context: AgentContext = { systemPrompt: deps.systemPrompt, messages: transcript, tools: [] };
  const config: AgentLoopConfig = {
    model,
    convertToLlm,
    getApiKey: () => deps.apiKey,
  };

  const updated = await runAgentLoop([prompt], context, config, () => {}, undefined, streamSimple);
  await deps.storage.put(TRANSCRIPT_KEY, updated);
  return lastAssistantText(updated).trim() || 'NO_REPLY';
};
