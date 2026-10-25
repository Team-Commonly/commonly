import { BSON } from 'mongodb';
import type { IAgentRunTurn, IAgentRunTurnToolCall } from '../models/AgentRun';

// An audit summary, not another copy of tool content. Keep turns below two
// MiB in BSON, leaving room for top-level metrics far below Mongo's 16 MiB.
// Count limits also bound the amount of trace the browser has to render.
export const RUN_TRACE_BYTES = 2 * 1024 * 1024;
export const RUN_VALUE_BYTES = 4096;
const MAX_TURNS = 128;
const MAX_CALLS_PER_TURN = 64;

const text = (value: unknown, limit = 256): string | undefined => (
  typeof value === 'string' ? value.slice(0, limit) : undefined
);

export function boundRunValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    const bytes = Buffer.byteLength(encoded ?? 'null');
    // Limit nested/array overhead independently of its encoded byte size.
    let nodes = 0;
    JSON.stringify(value, (_key, entry) => { nodes += 1; return entry; });
    return bytes <= RUN_VALUE_BYTES && nodes <= 256
      ? value : { truncated: true, originalBytes: bytes };
  } catch { return { truncated: true, unserializable: true }; }
}

export function boundAgentRun(run: {
  turns?: IAgentRunTurn[]; traceTruncated?: boolean; omittedTurns?: number;
  omittedToolCalls?: number; errorMessage?: string;
}) {
  let omittedTurns = run.omittedTurns || 0;
  let omittedToolCalls = run.omittedToolCalls || 0;
  let truncated = Boolean(run.traceTruncated);
  let remaining = RUN_TRACE_BYTES;
  const turns: IAgentRunTurn[] = [];
  for (const original of run.turns || []) {
    if (turns.length >= MAX_TURNS) {
      omittedTurns += 1;
      omittedToolCalls += original.toolCalls.length;
      continue;
    }
    const turn: IAgentRunTurn = {
      turnIndex: original.turnIndex, model: text(original.model) || 'unknown',
      promptTokens: original.promptTokens, completionTokens: original.completionTokens,
      totalTokens: original.totalTokens, elapsedMs: original.elapsedMs,
      liteLLMCallId: text(original.liteLLMCallId),
      llmResponseText: text(original.llmResponseText, 4096), toolCalls: [],
    };
    if (original.llmResponseText !== turn.llmResponseText) truncated = true;
    const overhead = BSON.calculateObjectSize(JSON.parse(JSON.stringify(turn))) + 32;
    if (remaining < overhead) {
      omittedTurns += 1;
      omittedToolCalls += original.toolCalls.length;
      continue;
    }
    remaining -= overhead;
    for (const originalCall of original.toolCalls) {
      const call: IAgentRunTurnToolCall = {
        name: text(originalCall.name) || 'unknown', elapsedMs: originalCall.elapsedMs,
        args: boundRunValue(originalCall.args), result: boundRunValue(originalCall.result),
        error: text(originalCall.error, 1024), callId: text(originalCall.callId),
        outcome: text(originalCall.outcome),
      };
      if (call.args !== originalCall.args || call.result !== originalCall.result
        || call.error !== originalCall.error) truncated = true;
      const bytes = BSON.calculateObjectSize(JSON.parse(JSON.stringify(call))) + 16;
      if (turn.toolCalls.length >= MAX_CALLS_PER_TURN || remaining < bytes) omittedToolCalls += 1;
      else { turn.toolCalls.push(call); remaining -= bytes; }
    }
    turns.push(turn);
  }
  return {
    turns, omittedTurns, omittedToolCalls,
    traceTruncated: truncated || omittedTurns > 0 || omittedToolCalls > 0,
    errorMessage: text(run.errorMessage, 1000),
  };
}
