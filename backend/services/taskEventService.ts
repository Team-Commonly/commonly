/**
 * taskEventService
 *
 * Emits task board change events into pod rooms over Socket.io. Called from
 * server-side routes (tasksApi) so clients viewing the Kanban board see
 * creates / updates / deletes in real time without waiting for the 20s poll.
 *
 * Payload shape: { podId, task, kind } where kind is 'created'|'updated'|'deleted'.
 * Events are emitted into `pod_{podId}` rooms so only clients subscribed to
 * the pod receive them — matches the agentTypingService / newMessage pattern.
 */

interface SocketIOLike {
  to: (room: string) => { emit: (event: string, payload: unknown) => void };
}

let ioRef: SocketIOLike | null = null;

export type TaskEventKind = 'created' | 'updated' | 'deleted';

export interface TaskEventPayload {
  podId: string;
  task: unknown;
  kind: TaskEventKind;
}

export function bindSocketIO(io: SocketIOLike): void {
  ioRef = io;
}

/**
 * Emit a task_updated event into the pod's socket room.
 * Safe no-op if socket.io has not been bound yet (e.g. during tests).
 */
export function emitTaskUpdated(podId: unknown, task: unknown, kind: TaskEventKind): void {
  if (!ioRef) return;
  if (!podId || !task) return;
  const normalizedPodId = String(podId);
  try {
    const payload: TaskEventPayload = { podId: normalizedPodId, task, kind };
    ioRef.to(`pod_${normalizedPodId}`).emit('task_updated', payload);
  } catch (err) {
    console.warn('[task-event] emit failed:', (err as Error).message);
  }
}

/**
 * Wake the pod's agents on a board change (ADR-024 D1, "producer parity").
 *
 * `emitTaskUpdated` above reaches Socket.io and stops, so a human watching the
 * Kanban sees the board move and an agent installed in the same pod learns
 * nothing. That asymmetry is why the fleet is 100% reactive: an agent can only
 * respond to being named, because being named is the only thing that reaches
 * it. Seven socket-emitting producers in this backend have zero enqueues
 * between them; this makes one of them do both.
 *
 * Three deliberate choices, each with a cheaper wrong version:
 *
 * 1. `message.posted`, NOT a new `task.*` type. A bespoke type reaches NEITHER
 *    runtime — the wrapper drops unrecognised types (PROMPT_EVENT_TYPES is a
 *    closed set) and the native tier discards the payload in its default
 *    branch. A `task.updated` event would enqueue, deliver, ack, and do
 *    nothing: this system's signature failure, where a break degrades to
 *    silence and silence reads like a considered decision. #970 already proved
 *    the ride-an-existing-type route on reaction receipts.
 *
 * 2. A synthetic claim key. Without `payload.messageId` the wrapper skips the
 *    claim gate entirely, so every agent in the pod spawns on every board
 *    change. `task:<id>:<kind>:<rev>` is opaque to MessageClaimService (which
 *    never validates the key against a real message), so the existing CAS
 *    elects exactly one actor per change and the rest stand down. One task,
 *    one worker, no new mechanism.
 *
 * 3. `dmKind` reflects the ACTOR, so agent-driven churn is priced. An agent
 *    moving a task wakes a peer, who may move a task, who wakes a peer. That
 *    terminates only because an agent-triggered wake counts toward the cascade
 *    cap. Defaulting an UNKNOWN actor to 'agent-agent' is the safe direction:
 *    mislabelling a human costs one suppressed wake, mislabelling an agent
 *    costs an unbounded loop. This rides the same `dmKind` overload that #1018
 *    tracks retiring in favour of `triggerAuthor` — inherited knowingly rather
 *    than inventing a second field needing its own release cycle.
 */
export async function notifyPodAgents(
  podId: unknown,
  task: Record<string, unknown>,
  kind: TaskEventKind,
  actor?: { userId?: unknown; isAgent?: boolean },
): Promise<void> {
  // A deletion leaves nothing to pick up, and a tombstone wake spends a model
  // turn to discover there is no work.
  if (kind === 'deleted') return;
  if (!podId || !task) return;

  try {
    /* eslint-disable global-require, @typescript-eslint/no-require-imports */
    const { AgentInstallation } = require('../models/AgentRegistry');
    const AgentEventService = require('./agentEventService');
    // Lazy so this never forms a load-time cycle with the mention service.
    const { wakeOnMessageEnabled } = require('./agentMentionService');
    /* eslint-enable global-require, @typescript-eslint/no-require-imports */

    const normalizedPodId = String(podId);
    const active = await AgentInstallation.find({
      podId: normalizedPodId,
      status: 'active',
    }).lean();

    // Gate on the SAME per-install opt-in as ADR-018 D8 wake-on-message. A
    // board change is ambient pod activity that nobody addressed to you, which
    // is precisely what that switch governs — so an agent whose owner turned
    // ambient wakes OFF must not start receiving them through a second door.
    // Measured before choosing this: of 367 active installs, 128 have it on
    // (including every sprint seat), and the 169 that do not are `commonly-bot`
    // and `openclaw` — user-facing and community seats where an unrequested
    // wake is a noise incident, not a feature.
    const installs = (active || []).filter(wakeOnMessageEnabled);
    if (!installs.length) return;

    const taskId = String(task.taskId || task.id || task._id || 'unknown');
    const title = String(task.title || '(untitled)');
    const status = String(task.status || 'unknown');
    const assignee = task.assignee ? String(task.assignee) : null;
    // Distinguishes successive changes to the SAME task, so a later update is a
    // fresh race rather than colliding with an earlier update's settled claim.
    const rev = String(task.updatedAt || task.claimExpiresAt || '');
    const claimKey = `task:${taskId}:${kind}:${rev}`;

    const content = [
      `[Board update in this pod: task ${taskId} was ${kind}.]`,
      '',
      `${taskId} — ${title}`,
      `status: ${status}${assignee ? `, assigned to ${assignee}` : ', UNASSIGNED'}`,
      '',
      'You are seeing this because you are installed in this pod, not because',
      'anyone named you. Decide whether it needs YOU specifically:',
      '- Unassigned work you can actually do: claim it and start.',
      '- Assigned to someone else, already handled, or not your area: return NO_REPLY.',
      '',
      'Do not narrate the board back to the pod. Post only if you are taking the',
      'work, or a human needs a decision from you.',
    ].join('\n');

    // Self-skip, but ONLY for an agent actor. `installedBy` holds the agent's
    // own user id when an agent self-installs, and the HUMAN's id when a human
    // installs it — the same field meaning two different things. Skipping on it
    // unconditionally silenced every agent for the exact person most likely to
    // be editing the board: whoever installed it. So the skip is scoped to the
    // case where the field genuinely identifies the actor.
    const actorId = actor?.isAgent && actor?.userId ? String(actor.userId) : null;
    await Promise.all(installs.map(async (install: Record<string, unknown>) => {
      if (actorId && String(install.installedBy || '') === actorId) return;
      try {
        await AgentEventService.enqueue({
          agentName: install.agentName,
          instanceId: install.instanceId || 'default',
          podId: normalizedPodId,
          type: 'message.posted',
          payload: {
            content,
            messageId: claimKey,
            podId: normalizedPodId,
            taskId,
            taskKind: kind,
            // See choice 3 above: an unknown actor is priced as an agent.
            dmKind: actor?.isAgent === false ? 'user-agent' : 'agent-agent',
          },
        });
      } catch (err) {
        console.warn(`[task-event] enqueue failed for ${install.agentName}:`, (err as Error).message);
      }
    }));
  } catch (err) {
    // A board change must never fail because the agent fan-out did.
    console.warn('[task-event] agent notify failed:', (err as Error).message);
  }
}

export default {
  bindSocketIO,
  emitTaskUpdated,
  notifyPodAgents,
};

// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
