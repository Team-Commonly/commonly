import { APPROVAL_OUTCOME_UNKNOWN } from './brokerWriteOutcome';

// A card's stored text says "[approval needed]" for good, and only its payload
// moves on. Read as written, a declined card reads as still waiting (Growth's
// walk, 2026-11-07: "still waiting above" under a Declined card). An approval
// whose action failed mustn't read as done, so the action's ending comes first.
// Every place pod messages are SHOWN to an agent goes through this: the native
// turn's context (nativeRuntimeService), and the runtime messages, bot-messages
// and context reads plus the pod-context summary (getRecentMessages with
// { cardOutcome: true }), which BYO and MCP agents use (F290). Internal checks
// that compare text, such as the duplicate-post guard, keep the stored text.
export const cardOutcome = (card: Record<string, unknown>): string | null => {
  if (card.status === 'expired') return 'expired';
  if (card.status === 'moot') return 'closed';
  if (card.status !== 'resolved') return null;
  if (card.decision === 'declined') return 'declined';
  // It may have run, so calling it failed would invite a second write.
  if (card.toolCallCode === APPROVAL_OUTCOME_UNKNOWN) return 'outcome unknown';
  const result = card.executionResult as { isError?: unknown } | undefined;
  const failed = Boolean(card.executionError) || result?.isError === true
    || card.toolCallEnding === 'failed' || card.toolCallEnding === 'refused';
  if (failed) return 'failed';
  // Approved, and nothing recorded how it ended: not the same as done.
  if (card.actionType === 'tool_call' && !card.toolCallEnding && result === undefined) return 'outcome unknown';
  return 'approved';
};

export const contentWithCardOutcome = (row: Record<string, unknown>): string => {
  const content = String(row.content || '');
  const card = row.payload as Record<string, unknown> | null | undefined;
  if (card?.kind !== 'approval-card') return content;
  const outcome = cardOutcome(card);
  return outcome ? content.replace(/^\s*\[approval needed\]/, `[approval ${outcome}]`) : content;
};
