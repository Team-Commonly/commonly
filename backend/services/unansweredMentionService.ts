import { emitUnansweredMentionLine } from './systemActionLineService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');

/**
 * TASK-656. The event types that mean a person is waiting on this agent: the
 * wrapper's PERSON_WAITING_EVENT_TYPES (cli/src/commands/agent.js). When one
 * exhausts the requeue cap, the person gets one visible line instead of
 * silence.
 */
export const PERSON_WAITING_EVENT_TYPES: readonly string[] = ['chat.mention', 'thread.mention', 'dm.message'];

interface RetiredEvent {
  agentName?: string;
  instanceId?: string;
  podId?: unknown;
  attempts?: number;
  createdAt?: Date | string;
  payload?: Record<string, unknown> | null;
}

interface PgPool {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Posts the unanswered-mention line for an event the requeue cap just retired,
 * when a person is the one waiting. Returns whether a line was posted.
 *
 * Stays silent when:
 * - the wake came from the kernel (assigned work, a board change) or from an
 *   agent: nobody is waiting on it. A welcome wake is a newcomer's first
 *   message, so it does get the line;
 * - the agent has posted in the pod since the message. It was alive and may
 *   have answered without acknowledging, and a line claiming silence would
 *   then be false. Missing a line is better than a wrong one.
 */
export async function noteUnansweredMention(event: RetiredEvent): Promise<boolean> {
  const payload = (event.payload || {}) as Record<string, unknown>;
  if (payload.triggerAuthor === 'kernel' || payload.assignedTaskWake === true || payload.boardWake === true) {
    return false;
  }
  const senderId = typeof payload.userId === 'string' || typeof payload.userId === 'number'
    ? String(payload.userId) : '';
  if (!/^[a-f0-9]{24}$/i.test(senderId)) return false;
  const sender = await User.findById(senderId).select('isBot').lean() as { isBot?: boolean } | null;
  if (!sender || sender.isBot) return false;

  const agentName = AgentIdentityService.resolveAgentType(String(event.agentName || ''));
  const instanceId = String(event.instanceId || 'default');
  const agent = await User.findOne({
    isBot: true,
    'botMetadata.agentName': agentName,
    'botMetadata.instanceId': instanceId,
  }).select('username profilePicture botMetadata').lean() as {
    _id: unknown; username?: string; profilePicture?: string | null;
    botMetadata?: { displayName?: string; instanceId?: string };
  } | null;
  if (!agent) return false;

  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };
  if (!pool) return false;
  const podId = String(event.podId || '');
  const since = new Date(event.createdAt || 0);
  const { rows } = await pool.query(
    `SELECT 1 FROM messages
     WHERE pod_id = $1 AND user_id = $2 AND created_at > $3 AND message_type <> 'system'
     LIMIT 1`,
    [podId, String(agent._id), since],
  );
  if (rows.length > 0) return false;

  await emitUnansweredMentionLine({
    podId,
    actorUserId: String(agent._id),
    actorUsername: agent.username || agentName,
    actorAvatarUrl: agent.profilePicture || null,
    actorIsBot: true,
    agentLabel: AgentIdentityService.resolveAgentDisplayLabel(agent, agentName),
    attempts: Number(event.attempts) || 0,
    messageId: (payload.messageId as string | number | null | undefined) ?? null,
    threadRootId: (payload.threadRootId as string | number | null | undefined) ?? null,
  });
  return true;
}
