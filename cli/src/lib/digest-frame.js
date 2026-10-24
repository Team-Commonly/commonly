// One counts-only frame for both the wrapper run loop and agent connect.
// Ambient bodies stay in the inbox; waking turns receive conversation counts.
export const formatDigestFrame = (events, rollup) => {
  if (events.length === 0 && !(rollup?.unreadCount > 0)) return null;

  const counts = new Map();
  let knownOlder = 0;
  for (const conversation of Array.isArray(rollup?.conversations) ? rollup.conversations : []) {
    if (typeof conversation.label !== 'string' || !Number.isInteger(conversation.count)
      || conversation.count < 1) continue;
    counts.set(conversation.label, (counts.get(conversation.label) || 0) + conversation.count);
    knownOlder += conversation.count;
  }
  if (rollup?.unreadCount > knownOlder) {
    counts.set('older pod activity',
      (counts.get('older pod activity') || 0) + rollup.unreadCount - knownOlder);
  }

  const seen = new Set();
  for (const event of events) {
    const payload = event.payload || {};
    const sourceId = payload.messageId != null ? `message:${payload.messageId}`
      : (typeof payload.taskId === 'string'
        ? `task:${payload.taskId}:${String(payload.taskKind || '')}:${String(payload.content || '')}` : null);
    if (sourceId && seen.has(sourceId)) continue;
    if (sourceId) seen.add(sourceId);

    const thread = payload.threadRootId;
    const task = payload.taskId;
    const validThread = (typeof thread === 'number' && Number.isInteger(thread) && thread > 0)
      || (typeof thread === 'string' && /^[1-9]\d*$/.test(thread));
    const label = validThread ? `thread ${thread}`
      : (typeof task === 'string' && /^TASK-\d+$/.test(task) ? task : 'pod conversation');
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  const lines = [...counts].slice(0, 8).map(([label, count]) => `- ${label}: ${count} unread`);
  if (counts.size > 8) lines.push(`- ${counts.size - 8} more conversations omitted`);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return `[Since you last looked: ${total} ambient update${total === 1 ? '' : 's'} in ${counts.size} conversation${counts.size === 1 ? '' : 's'}; context only, no reply needed.]\n`
    + `${lines.join('\n')}\nPull relevant messages with commonly_get_messages. On resume, read oldest unread first; at most 8 conversations, 5 messages each, 20 messages total.`;
};
