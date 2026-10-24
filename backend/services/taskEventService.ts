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
const MAX_NAMED_ITEMS = 5;
const MAX_ASSIGNED_ROWS = 5;
type BoardTask = Record<string, unknown>;

function seatMatchesAssignee(install: Record<string, unknown>, assignee: unknown): boolean {
  if (!assignee) return false;
  const name = String(install.agentName || '').toLowerCase();
  const instance = String(install.instanceId || 'default').toLowerCase();
  const assigned = String(assignee).toLowerCase();
  return instance === 'default' ? assigned === name : assigned === instance;
}

async function claimHolderKey(claimedBy: unknown): Promise<string | null> {
  if (!claimedBy) return null;
  const claim = String(claimedBy);
  if (!/^[0-9a-f]{24}$/i.test(claim)) return `::${claim.toLowerCase()}`;
  // Claims store the bot User id; installedBy can instead name the human.
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');
  const holder = await User.findById(claim).select('isBot botMetadata').lean();
  if (!holder?.isBot || !holder.botMetadata?.agentName) return null;
  return `${String(holder.botMetadata.agentName).toLowerCase()}::${String(holder.botMetadata.instanceId || 'default').toLowerCase()}`;
}

function seatHoldsClaim(install: Record<string, unknown>, holderKey: string | null): boolean {
  if (!holderKey) return false;
  const name = String(install.agentName || '').toLowerCase();
  const instance = String(install.instanceId || 'default').toLowerCase();
  return holderKey === `${name}::${instance}`
    || (instance !== 'default' && holderKey === `::${instance}`)
    || (instance === 'default' && holderKey === `::${name}`);
}

async function usesHostedBoardWake(
  install: Record<string, unknown>,
  AgentInstallation: any,
): Promise<boolean> {
  // Match agentEventService.resolveInProcessInstallation: a mention-created
  // pod projection can omit runtime and inherit it from the identity's latest
  // configured installation. Both hosted engines answer chat.mention.
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { isHostedInstallation, readRuntimeConfig } = require('./hostedRuntimeService');
  if (readRuntimeConfig(install).runtimeType) return isHostedInstallation(install);
  try {
    const sibling = await AgentInstallation.findOne({
      agentName: String(install.agentName || '').toLowerCase(),
      instanceId: String(install.instanceId || 'default'),
      status: 'active',
      'config.runtime.runtimeType': { $exists: true },
    }).sort({ createdAt: -1 }).lean();
    return isHostedInstallation(sibling);
  } catch (err) {
    // chat.mention is answered by hosted and external drivers. Failing toward
    // that route keeps an addressed owner awake when classification is down.
    console.warn('[task-event] runtime lookup failed:', (err as Error).message);
    return true;
  }
}

export interface TaskEventPayload {
  podId: string;
  task: unknown;
  kind: TaskEventKind;
}

export interface PodFocusEventPayload {
  podId: string;
  revision: number;
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

/** Notify pod clients that the shared focus projection changed. */
export function emitPodFocusUpdated(podId: unknown, revision: number): void {
  if (!ioRef || !podId || !Number.isInteger(revision)) return;
  const normalizedPodId = String(podId);
  try {
    const payload: PodFocusEventPayload = { podId: normalizedPodId, revision };
    ioRef.to(`pod_${normalizedPodId}`).emit('pod_focus_updated', payload);
  } catch (err) {
    console.warn('[task-event] focus emit failed:', (err as Error).message);
  }
}

type OfferRevision = {
  _id?: unknown;
  taskId?: unknown;
  updatedAt?: unknown;
};

/**
 * Stamp only the exact task revisions offered. A concurrent board edit leaves
 * its newer updatedAt unmatched and due for the next sweep.
 */
async function stampOfferedRevisions(revisions: OfferRevision[]): Promise<void> {
  const candidates = revisions.filter((revision) => revision._id && revision.updatedAt);
  if (!candidates.length) return;

  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const Task = require('../models/Task');
  await Promise.all(candidates.map(async (revision) => {
    try {
      await Task.updateOne(
        { _id: revision._id, updatedAt: revision.updatedAt },
        { $set: { offeredAt: revision.updatedAt } },
        { timestamps: false },
      );
    } catch (err) {
      console.warn(
        '[task-event] offered-at stamp failed for '
          + String(revision.taskId || revision._id) + ':',
        (err as Error).message,
      );
    }
  }));
}

/**
 * Wake a task's owning seats on a board change (ADR-024 D1).
 *
 * `emitTaskUpdated` above reaches Socket.io and stops, so a human watching the
 * Kanban sees the board move while the agent owning that row learns nothing.
 * Seven socket-emitting producers in this backend have zero enqueues between
 * them; this one also delivers an addressed wake to the row's owner.
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
 *    instead of appending. Only the row's current or prior owner receives that
 *    wake; unrelated movement remains on the durable board. There is no
 *    messageId because an assignment is addressed to its owner.
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
  previousTask?: BoardTask | null,
): Promise<void> {
  // A deletion leaves nothing to pick up, and a tombstone wake spends a model
  // turn to discover there is no work.
  if (kind === 'deleted') return;
  if (!podId || !task) return;

  try {
    /* eslint-disable global-require, @typescript-eslint/no-require-imports */
    const { AgentInstallation } = require('../models/AgentRegistry');
    const AgentEventService = require('./agentEventService');
    const Task = require('../models/Task');
    /* eslint-enable global-require, @typescript-eslint/no-require-imports */

    const normalizedPodId = String(podId);
    const active = await AgentInstallation.find({
      podId: normalizedPodId,
      status: 'active',
    }).lean();

    // Ownership addresses a seat directly, independent of ambient wake opt-in.
    const installs = active || [];
    if (!installs.length) return;

    const taskId = String(task.taskId || task.id || task._id || 'unknown');
    const title = String(task.title || '(untitled)').replace(/\s+/g, ' ');

    const buildContent = (extraChanges: number, assignedRows: Array<Record<string, unknown>>): string => [
      extraChanges > 0
        ? `[The board moved in this pod — ${extraChanges + 1} changes since your last wake, most recent: ${taskId} ${kind}.]`
        : `[The board moved in this pod — ${taskId} was ${kind}: ${title}.]`,
      ...(assignedRows.length ? [
        '',
        '[Your assigned rows (pending/claimed; newest first):]',
        ...assignedRows.map((row) => {
          const updates = row.updates as Array<{ text?: string }> | undefined;
          const latest = updates?.[updates.length - 1]?.text;
          const change = latest || (String(row.taskId) === taskId ? kind : 'current assignment');
          return `- ${String(row.taskId)} — ${String(row.title || '(untitled)').replace(/\s+/g, ' ').slice(0, 80)} [${String(row.status)}] — ${String(change).replace(/\s+/g, ' ').slice(0, 120)}`;
        }),
      ] : []),
      '',
      'You are seeing this because you are installed here, not because anyone',
      'named you. Look at what is pending and decide what needs YOU:',
      '- Work you can genuinely do: claim it first, then start.',
      '- A claim that comes back 409: a peer has it. Leave it and move on.',
      '- Nothing in your area: return NO_REPLY as your ENTIRE reply. That is',
      '  the common case. Suppression is total-match: anything you write after',
      '  the token is posted publicly (AX entry 43).',
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
    let currentHolder: string | null = null;
    let previousHolder: string | null = null;
    let dependentRows: BoardTask[] = [];
    let dependentHolders: Array<string | null> = [];
    try {
      [currentHolder, previousHolder] = await Promise.all([
        claimHolderKey(task.claimedBy), claimHolderKey(previousTask?.claimedBy),
      ]);
      if (String(task.status) === 'done' && previousTask && String(previousTask.status) !== 'done') {
        dependentRows = await Task.find(
          { podId: normalizedPodId, dep: taskId, status: { $in: ['pending', 'claimed', 'blocked'] } },
          { assignee: 1, claimedBy: 1 },
        ).lean();
        dependentHolders = await Promise.all(dependentRows.map((row) => claimHolderKey(row.claimedBy)));
      }
    } catch (err) {
      // Preserve known assignees even if a claim or dependency lookup fails.
      console.warn('[task-event] own-row lookup failed:', (err as Error).message);
    }
    const outcomes = await Promise.all(installs.map(async (install: Record<string, unknown>) => {
      const installKey = `${String(install.agentName || '').toLowerCase()}::${String(install.instanceId || 'default')}`;
      if (actorKey && installKey === actorKey) return null;
      const agentName = install.agentName;
      const instanceId = install.instanceId || 'default';
      const ownRow = seatMatchesAssignee(install, task.assignee)
        || seatMatchesAssignee(install, previousTask?.assignee)
        || seatHoldsClaim(install, currentHolder)
        || seatHoldsClaim(install, previousHolder)
        || dependentRows.some((row) => seatMatchesAssignee(install, row.assignee))
        || dependentHolders.some((holder) => seatHoldsClaim(install, holder));
      if (!ownRow) return null;
      try {
        // Both hosted engines answer chat.mention; they acknowledge a generic
        // message.posted without a turn. Other drivers use message.posted.
        const eventType = await usesHostedBoardWake(install, AgentInstallation)
          ? 'chat.mention' : 'message.posted';
        // Assignee is the board's agent-name string. Query the current board
        // for this seat rather than replaying only the latest pod-wide edit:
        // an assignment must be visible even when another edit folds into it.
        // The compound (podId, assignee, status) index bounds this lookup.
        let assignedRows: Array<Record<string, unknown>> = [];
        try {
          const assignees = instanceId === 'default' || instanceId === agentName
            ? [agentName] : [instanceId];
          assignedRows = await Task.find(
            { podId: normalizedPodId, assignee: { $in: assignees }, status: { $in: ['pending', 'claimed'] } },
            { taskId: 1, title: 1, status: 1, updatedAt: 1, updates: { $slice: -1 } },
          ).sort({ updatedAt: -1, _id: -1 }).limit(MAX_ASSIGNED_ROWS).lean();
        } catch (err) {
          // A listing failure must not turn the entire board wake into silence.
          console.warn(`[task-event] assigned rows lookup failed for ${agentName}:`, (err as Error).message);
        }
        // Fold into this seat's undrained board wake if it has one. Matches on
        // Match `payload.boardWake`, never the event type: non-hosted wakes
        // share message.posted with chat, and hosted wakes use chat.mention.
        // Folding into an unread chat message would destroy it.
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
            ...(eventType === 'chat.mention' || dmKind === 'user-agent'
              ? { $set: {
                ...(eventType === 'chat.mention' ? { type: 'chat.mention' } : {}),
                ...(dmKind === 'user-agent' ? { 'payload.dmKind': 'user-agent' } : {}),
              } } : {}),
          },
          { new: true },
        );

        if (folded) {
          // Rewrite the content to reflect the true count. Separate from the
          // $inc because the summary line needs the POST-increment value.
          const extra = Number(folded.payload?.boardChanges || 1);
          const rewrite = await AgentEvent.updateOne(
            { _id: folded._id, status: 'pending' },
            { $set: { 'payload.content': buildContent(extra, assignedRows) } },
          );
          if (rewrite?.matchedCount === 0) return undefined;
          return true;
        }

        await AgentEventService.enqueue({
          agentName,
          instanceId,
          podId: normalizedPodId,
          type: eventType,
          payload: {
            content: buildContent(0, assignedRows),
            // No messageId; ownership itself is the address.
            podId: normalizedPodId,
            boardWake: true,
            boardChanges: 0,
            taskId,
            taskKind: kind,
            // See choice 3: an unknown actor is priced as an agent.
            dmKind,
          },
        });
        return true;
      } catch (err) {
        console.warn(`[task-event] enqueue failed for ${agentName}:`, (err as Error).message);
      }
    }));
    const failed = outcomes.some((outcome) => outcome === undefined);
    const offered = outcomes.some((outcome) => outcome === true);
    if (offered && !failed) {
      await stampOfferedRevisions([task]);
    }
  } catch (err) {
    // A board change must never fail because the agent fan-out did.
    console.warn('[task-event] agent notify failed:', (err as Error).message);
  }
}

/**
 * Kernel-sweep wake (#1044): the pod has actionable work — pending, unassigned
 * — and the kernel found it, so no model turn was spent discovering it.
 *
 * Differences from `notifyPodAgents`, each deliberate:
 *
 * - `triggerAuthor: 'kernel'` and NO dmKind. The third pricing branch (fable,
 *   55845): kernel-found work is not agent churn — priced 'agent' it counts
 *   toward the cascade cap and silences seats exactly when the board is
 *   busiest; priced 'human' it clears the brake on unrelated cascades. CLIs
 *   that predate the branch see no dmKind and no messageId and classify
 *   'unknown', which is neutral — graceful degradation, not breakage.
 * - The content NAMES the work. "If the payload can't name work, don't wake
 *   the seat" is the ruling this exists to satisfy; a wake that says "go
 *   look" re-creates the HEARTBEAT_OK turn-burner one layer down.
 * - Same `boardWake` fold as change wakes, so a sweep wake and a change wake
 *   collapse into ONE pending wake per seat rather than queueing separately.
 *   Known bounded leak, recorded not fixed (same stance as fable's 55846): an
 *   agent change folding into a pending kernel wake rides under kernel
 *   pricing — at most one per drain.
 * - The sweep passes every due row for stamping, though only five are named in
 *   the wake. Revisions are stamped only after every eligible seat succeeds;
 *   one failure leaves the batch due for the next pass.
 */
export async function notifyFoundWork(
  podId: unknown,
  items: Array<OfferRevision & { title?: string; lapsedFrom?: string | null }>,
  totalCount: number,
  now: Date = new Date(),
): Promise<{ woken: number }> {
  if (!podId || !items?.length) return { woken: 0 };
  try {
    /* eslint-disable global-require, @typescript-eslint/no-require-imports */
    const { AgentInstallation } = require('../models/AgentRegistry');
    const AgentEventService = require('./agentEventService');
    const { boardWakeEnabled } = require('./agentMentionService');
    const AgentEvent = require('../models/AgentEvent');
    /* eslint-enable global-require, @typescript-eslint/no-require-imports */

    const normalizedPodId = String(podId);
    const active = await AgentInstallation.find({ podId: normalizedPodId, status: 'active' }).lean();
    const installs = (active || []).filter(boardWakeEnabled);
    if (!installs.length) return { woken: 0 };

    // #1080 part 3: a rescued row names who it lapsed from. Without it the wake
    // says "unclaimed" about work that has an open PR against it, and the only
    // thing standing between that and a duplicate implementation is whether a
    // peer happens to be reading the pod. Two reviewers hand-warned the room
    // about exactly this on TASK-015 within one minute of each other.
    const namedItems = items.slice(0, MAX_NAMED_ITEMS);
    const listed = namedItems
      .map((t) => {
        const line = `- ${t.taskId || '?'} — ${String(t.title || '(untitled)').slice(0, 80)}`;
        return t.lapsedFrom ? `${line}  [lapsed from ${t.lapsedFrom} — check their work before starting]` : line;
      })
      .join('\n');
    const more = totalCount > namedItems.length
      ? `\n…and ${totalCount - namedItems.length} more on the board.`
      : '';
    const content = [
      `[The kernel found unclaimed work in this pod — ${totalCount} pending, unassigned:]`,
      '',
      listed + more,
      '',
      'Nobody named you; the board did. If one of these is genuinely yours to',
      'do: claim it first (a 409 means a peer got there — move on), then start.',
      'If none fit your role, return NO_REPLY as your ENTIRE reply — anything',
      'written after the token is posted publicly. Do not narrate the list back.',
    ].join('\n');

    let woken = 0;
    const outcomes = await Promise.all(installs.map(async (install: Record<string, unknown>) => {
      const agentName = install.agentName;
      const instanceId = install.instanceId || 'default';
      try {
        const folded = await AgentEvent.findOneAndUpdate(
          {
            agentName, instanceId, podId: normalizedPodId, status: 'pending', 'payload.boardWake': true,
          },
          { $set: { 'payload.content': content, 'payload.foundWorkAt': now } },
          { new: true },
        );
        if (folded) { woken += 1; return true; }
        await AgentEventService.enqueue({
          agentName,
          instanceId,
          podId: normalizedPodId,
          type: 'message.posted',
          payload: {
            content,
            podId: normalizedPodId,
            boardWake: true,
            boardChanges: 0,
            foundWorkAt: now,
            // The third pricing branch. No dmKind, deliberately.
            triggerAuthor: 'kernel',
          },
        });
        woken += 1;
        return true;
      } catch (err) {
        console.warn(`[task-event] found-work enqueue failed for ${agentName}:`, (err as Error).message);
      }
    }));
    if (woken > 0 && outcomes.every((outcome) => outcome === true)) {
      await stampOfferedRevisions(items);
    }
    return { woken };
  } catch (err) {
    console.warn('[task-event] found-work notify failed:', (err as Error).message);
    return { woken: 0 };
  }
}

/**
 * #1080 part 2: warn the holder of a lapsed lease that the kernel is about to
 * take it back, instead of taking it back silently.
 *
 * Addressed to ONE seat — the holder — so unlike `notifyFoundWork` this does
 * not consult `wakeOnMessageEnabled`. The holder's own claim is the address;
 * an ambient opt-in is not what makes this relevant to them. It is also the
 * reason the warning is only ever sent to a seat that derived 'listening':
 * fable, 56213 — "the warning event works only BECAUSE it's gated on a live
 * seat — a dead seat ignoring it is the diagnosis, not the failure."
 *
 * Priced 'kernel' like every other sweep wake: neutral in the cascade
 * governor, counting toward nothing and clearing nothing.
 */
export async function notifyLeaseWarning(
  podId: unknown,
  holder: { agentName: string; instanceId: string; label: string },
  task: { taskId?: string; title?: string },
  deferralsUsed: number,
  maxDeferrals: number,
  now: Date = new Date(),
): Promise<{ warned: boolean }> {
  if (!podId || !holder?.agentName || !task?.taskId) return { warned: false };
  /* eslint-disable global-require, @typescript-eslint/no-require-imports */
  const AgentEventService = require('./agentEventService');
  const AgentEvent = require('../models/AgentEvent');
  /* eslint-enable global-require, @typescript-eslint/no-require-imports */

  const normalizedPodId = String(podId);
  const remaining = maxDeferrals - deferralsUsed;
  const content = [
    `[Your lease on ${task.taskId} has lapsed. You are still listening, so the kernel deferred the rescue — ${remaining} deferral${remaining === 1 ? '' : 's'} left.]`,
    '',
    `${task.taskId} — ${String(task.title || '(untitled)').slice(0, 80)}`,
    '',
    'The row is claimable by peers right now: deferral suppresses the kernel\'s',
    'rescue, not the board. To keep it, post a task update or re-claim — either',
    'renews the lease. If you have finished, complete it with the PR link. If it',
    'is no longer yours, do nothing and it returns to the board named as yours.',
  ].join('\n');

  try {
    // Fold rather than stack: three deferrals on one task must not become three
    // pending events. Keyed on the task, so a seat holding two lapsed rows is
    // warned once about each.
    const folded = await AgentEvent.findOneAndUpdate(
      {
        agentName: holder.agentName,
        instanceId: holder.instanceId || 'default',
        podId: normalizedPodId,
        status: 'pending',
        'payload.leaseWarningTaskId': task.taskId,
      },
      { $set: { 'payload.content': content, 'payload.deferralsUsed': deferralsUsed } },
      { new: true },
    );
    if (folded) return { warned: true };

    await AgentEventService.enqueue({
      agentName: holder.agentName,
      instanceId: holder.instanceId || 'default',
      podId: normalizedPodId,
      type: 'message.posted',
      payload: {
        content,
        podId: normalizedPodId,
        leaseWarningTaskId: task.taskId,
        deferralsUsed,
        warnedAt: now,
        // Same third pricing branch as the board wake. No dmKind, no messageId.
        triggerAuthor: 'kernel',
      },
    });
    return { warned: true };
  } catch (err) {
    console.warn('[task-event] lease warning failed:', (err as Error).message);
    return { warned: false };
  }
}

export default {
  bindSocketIO,
  emitTaskUpdated,
  emitPodFocusUpdated,
  notifyPodAgents,
  notifyFoundWork,
  notifyLeaseWarning,
};

// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
