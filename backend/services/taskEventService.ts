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
 * 2. Coalescing, NOT a per-task claim key. The first version of this used a
 *    synthetic `task:<id>:<kind>:<rev>` messageId so the claim CAS would elect
 *    one actor per change. @sprint-review killed it with a number: the claim
 *    key **dedupes action, never delivery**. Every opted-in seat is still
 *    enqueued and still wakes; the losers only discover they lost after
 *    spawning. A board sweep writing 39 rows across 4 opted-in seats is 156
 *    wakes, each one `agent-agent`, so every seat hits the cascade cap of 3
 *    within seconds and goes deaf for the reset window — D1 switched on would
 *    silence the fleet it exists to inform.
 *
 *    So the bound has to be on DELIVERY. At most one *pending* board wake per
 *    (agent, instance, pod): a second change folds into the undrained first
 *    instead of appending. 39 writes become 1 wake, and each seat looks at the
 *    board once rather than once per row. There is no messageId, deliberately
 *    — every seat SHOULD look; the per-task claim CAS already arbitrates who
 *    actually takes what, one layer down, where the contention really is.
 *
 *    This is a step toward ADR-024 D3's inbox, not a workaround around it:
 *    "collapse what is still undelivered" is what an inbox does.
 *
 *    Residual, stated rather than hidden: the fold is a findOneAndUpdate, so
 *    two board writes landing in the same instant can both miss and both
 *    insert. The bound is therefore "roughly one" pending wake, not exactly
 *    one — worst case a small constant, never the 39 it replaces. A sweep is
 *    sequential within one agent's turn, which is the case that actually
 *    produced the 156. Tightening it to exactly-one needs a unique partial
 *    index on (agentName, instanceId, podId) where status is pending and
 *    boardWake is true; deliberately not added here, because that index would
 *    also constrain every non-board event sharing those fields.
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
  actor?: {
    userId?: unknown;
    isAgent?: boolean;
    // Identity of the acting agent, when there is one. Carries the self-skip;
    // `userId` cannot, because `installedBy` is the human's id on a
    // human-installed agent.
    agentName?: string;
    instanceId?: string;
  },
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

    const buildContent = (extraChanges: number): string => [
      extraChanges > 0
        ? `[The board moved in this pod — ${extraChanges + 1} changes since your last wake, most recent: ${taskId} ${kind}.]`
        : `[The board moved in this pod — ${taskId} was ${kind}: ${title}.]`,
      '',
      'You are seeing this because you are installed here, not because anyone',
      'named you. Look at what is pending and decide what needs YOU:',
      '- Work you can genuinely do: claim it first, then start.',
      '- A claim that comes back 409: a peer has it. Leave it and move on.',
      '- Nothing in your area: return NO_REPLY. That is the common case.',
      '',
      'Do not narrate the board back to the pod. Post only if you are taking',
      'work, or a human needs a decision from you.',
    ].join('\n');

    // Self-skip keyed on IDENTITY, never on `installedBy`.
    //
    // `installedBy` means two different things — the agent's own user id when
    // an agent self-installs, the HUMAN's id when a human installs it — and
    // both readings have now shipped a bug, from opposite directions.
    // Comparing it against any actor silenced every agent for its own
    // installer, the person most likely to be moving tasks. Scoping that to
    // agent actors fixed the human case and left the mirror image, which
    // @pod-architect caught on review: a HUMAN-installed agent editing the
    // board does not match its installer's id, so it fails to skip and wakes
    // itself.
    //
    // (agentName, instanceId) identifies the acting agent under BOTH install
    // paths, which is what this skip has always meant. Normalised the way
    // AgentInstallation stores them — lowercased name, 'default' for a missing
    // instance — so a case difference cannot quietly reintroduce the self-wake.
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentEvent = require('../models/AgentEvent');
    const dmKind = actor?.isAgent === false ? 'user-agent' : 'agent-agent';

    const actorKey = actor?.isAgent && actor?.agentName
      ? `${String(actor.agentName).toLowerCase()}::${String(actor.instanceId || 'default')}`
      : null;
    await Promise.all(installs.map(async (install: Record<string, unknown>) => {
      const installKey = `${String(install.agentName || '').toLowerCase()}::${String(install.instanceId || 'default')}`;
      if (actorKey && installKey === actorKey) return;
      const agentName = install.agentName;
      const instanceId = install.instanceId || 'default';
      try {
        // Fold into this seat's undrained board wake if it has one. Matches on
        // `payload.boardWake` rather than the event type, because the type is
        // deliberately `message.posted` (shared with ordinary chat) and folding
        // a board change into someone's unread MESSAGE would destroy it.
        const folded = await AgentEvent.findOneAndUpdate(
          {
            agentName,
            instanceId,
            podId: normalizedPodId,
            status: 'pending',
            'payload.boardWake': true,
          },
          {
            $inc: { 'payload.boardChanges': 1 },
            // A human edit arriving on top of agent churn must re-price the
            // whole batch as human — otherwise one agent write early in a sweep
            // permanently marks a wake the human later contributed to.
            ...(dmKind === 'user-agent' ? { $set: { 'payload.dmKind': 'user-agent' } } : {}),
          },
          { new: true },
        );

        if (folded) {
          // Rewrite the content to reflect the true count. Separate from the
          // $inc because the summary line needs the POST-increment value.
          const extra = Number(folded.payload?.boardChanges || 1);
          await AgentEvent.updateOne(
            { _id: folded._id, status: 'pending' },
            { $set: { 'payload.content': buildContent(extra) } },
          );
          return;
        }

        await AgentEventService.enqueue({
          agentName,
          instanceId,
          podId: normalizedPodId,
          type: 'message.posted',
          payload: {
            content: buildContent(0),
            // No messageId, deliberately — see choice 2. Every seat should
            // look; the per-task claim CAS arbitrates who takes what.
            podId: normalizedPodId,
            boardWake: true,
            boardChanges: 0,
            taskId,
            taskKind: kind,
            // See choice 3: an unknown actor is priced as an agent.
            dmKind,
          },
        });
      } catch (err) {
        console.warn(`[task-event] enqueue failed for ${agentName}:`, (err as Error).message);
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
