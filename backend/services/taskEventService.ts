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
  actor?: { userId?: unknown; isAgent?: boolean; agentName?: string | null; instanceId?: string | null },
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
    // Milliseconds, NOT `String(date)`. `Date.prototype.toString()` renders to the
    // second, so two writes 800ms apart produced an identical rev, an identical
    // claimKey, and the second change's wake was swallowed by a claim the first
    // had already settled. That is not hypothetical once a rescue sweep exists:
    // it claims a lapsed row, rewrites it to pending, then reassigns it — three
    // writes on one task inside a second, of which only the FIRST survived. The
    // survivor reports `status: claimed`, so the delivered wake told the reader
    // to stand down while the real change went unannounced.
    //
    // A chosen bound, not exactness: two writes inside the SAME millisecond still
    // collide. The only monotonic alternative is a version counter, and Mongoose
    // does not bump `__v` on findOneAndUpdate — so ms is where this stops.
    const revSource = task.updatedAt || task.claimExpiresAt || null;
    const revTime = revSource ? new Date(revSource as string | number | Date).getTime() : NaN;
    const rev = Number.isNaN(revTime) ? '' : String(revTime);
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

    // Self-skip, keyed on IDENTITY rather than on `installedBy`.
    //
    // `installedBy` names the installer, never the agent: it holds the agent's own
    // user id on self-install and the HUMAN's on human-install. Scoping the skip to
    // agent actors fixed the human case and left its mirror open — a human-installed
    // agent (the normal path) never matched its own install, so it enqueued a wake to
    // itself on every board write. Those wakes are agent-triggered and count toward
    // the cascade streak, so a batch assignment starved the assigner: #1010's
    // starvation arriving through a new door.
    //
    // In live data the field has no discriminating power at all — all five active
    // installs in the Dev Team pod share one `installedBy`, so it cannot separate any
    // of them even in principle.
    //
    // `(agentName, instanceId)` is the identity the rest of this file already uses two
    // lines below, and the same pair `agentMentionService` uses for its self-mention
    // guard. Correct regardless of who installed the agent.
    const identityOf = (agentName: unknown, instanceId: unknown): string => (
      `${String(agentName || '').toLowerCase()}:${String(instanceId || 'default').toLowerCase()}`
    );
    const actorIdentity = actor?.isAgent && actor?.agentName
      ? identityOf(actor.agentName, actor.instanceId)
      : null;
    await Promise.all(installs.map(async (install: Record<string, unknown>) => {
      if (actorIdentity && identityOf(install.agentName, install.instanceId) === actorIdentity) return;
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
