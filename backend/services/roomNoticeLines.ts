/**
 * The system lines that tell the people in a room about an agent. They're stored
 * under the agent, so read back as context they look like its own words, and an
 * agent answering after a Start told someone the stopped notice was out of date.
 * The shell renders these same actions through SYSTEM_NOTICE_KEYS in V2MessageRow.
 */
const ROOM_NOTICE_ACTIONS: ReadonlySet<unknown> = new Set([
  'agent-stopped',
  'agent-removed',
  'agent-paused',
  'agent-offline',
  'agent-not-connected',
  'mention-unanswered',
]);

export const isRoomNotice = (row: Record<string, unknown>): boolean => {
  const payload = row.payload as { kind?: unknown; action?: unknown } | null | undefined;
  return row.message_type === 'system' && payload?.kind === 'system-action'
    && ROOM_NOTICE_ACTIONS.has(payload.action);
};
