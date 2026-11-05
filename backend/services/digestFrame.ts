/**
 * The digest summary a wake carries: unread conversations by label and count,
 * never message text, then one line telling the seat how to pull them.
 * agentEventService appends it to a wake's content (runWithDigest, and the
 * seat digest). It is kernel text, written once for every runtime, so the one
 * line that names a tool is exported: a driver without that tool rewrites
 * exactly this line (nativeKernelCue), not a guess at it.
 */

/** The digest's last line. It names a tool the native runtime does not have. */
export const DIGEST_PULL_LINE = 'Pull relevant messages with commonly_get_messages. '
  + 'On resume, read oldest unread first; at most 8 conversations, 5 messages each, 20 messages total.';

// A wake advertises unread conversations, not message text. The seat can
// choose which threads to pull with commonly_get_messages after it wakes.
export const digestConversationFrame = (
  rows: Array<{ payload?: Record<string, unknown> }>,
  olderCount = 0,
  olderConversations: Array<{ label: string; count: number }> = [],
): string => {
  const counts = new Map<string, number>();
  let knownOlder = 0;
  for (const conversation of olderConversations) {
    if (!conversation.label || !Number.isInteger(conversation.count) || conversation.count < 1) continue;
    counts.set(conversation.label, (counts.get(conversation.label) || 0) + conversation.count);
    knownOlder += conversation.count;
  }
  if (olderCount > knownOlder) counts.set('older pod activity', olderCount - knownOlder);
  const seen = new Set<string>();
  for (const row of rows) {
    const payload = row.payload || {};
    const sourceId = payload.messageId != null ? `message:${payload.messageId}`
      : (typeof payload.taskId === 'string'
        ? `task:${payload.taskId}:${String(payload.taskKind || '')}:${String(payload.content || '')}` : null);
    if (sourceId && seen.has(sourceId)) continue;
    if (sourceId) seen.add(sourceId);
    const thread = payload.threadRootId;
    const task = payload.taskId;
    const label = typeof thread === 'number' && Number.isInteger(thread) && thread > 0
      ? `thread ${thread}`
      : (typeof task === 'string' && /^TASK-\d+$/.test(task) ? task : 'pod conversation');
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const lines = [...counts].slice(0, 8).map(([label, count]) => `- ${label}: ${count} unread`);
  const omitted = Math.max(0, counts.size - 8);
  if (omitted) lines.push(`- ${omitted} more conversations omitted`);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return `[Since you last looked: ${total} ambient update${total === 1 ? '' : 's'} `
    + `in ${counts.size} conversation${counts.size === 1 ? '' : 's'}; context only, no reply needed.]\n`
    + `${lines.join('\n')}\n${DIGEST_PULL_LINE}`;
};
