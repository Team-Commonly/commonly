/**
 * Kernel work sweep (#1044, ruled by fable-lead).
 *
 * The ruling this implements, verbatim: "a timer that spends a model turn to
 * discover nothing is wrong at any breadth — the fix isn't a better tick, it's
 * moving the timer kernel-side. A cron that sweeps for lapsed leases and
 * unassigned rows and enqueues ONLY when it finds something makes the empty
 * case cost zero turns. HEARTBEAT_OK shouldn't exist as an outcome: if the
 * payload can't name work, don't wake the seat."
 *
 * Why the kernel and not an agent: the previous design rode theo's heartbeat
 * (a moltbot), and the moltbot tier is parked (#1050) — its credentials had
 * been dead for seven weeks without anyone noticing. That left "theo-less pods
 * and theo itself as a single point" (fable, 55842) as the uncovered case;
 * parking the tier made it the ONLY case. A lapsed→pending transition needs no
 * model judgment, so nothing about this requires an LLM at all.
 *
 * Fable's three build constraints, all enforced here or in the same PR:
 *  1. Writes carry a NAMED kernel actor (`kernel-sweep`) in the task's update
 *     trail — an unexplained status flip in an audit trail is how "the label
 *     chain failing where attribution is load-bearing" incidents start.
 *  2. Kernel-originated wakes carry `triggerAuthor: 'kernel'` and NO dmKind —
 *     the third pricing branch. Priced as 'agent' they would count toward the
 *     cascade cap and silence seats exactly when the board is busiest (more
 *     real work → more counted wakes). Priced as 'human' they would CLEAR the
 *     brake on unrelated cascades. Older CLIs that predate the branch see no
 *     dmKind and no messageId and classify 'unknown', which is neutral — so
 *     the safe behaviour degrades gracefully instead of breaking.
 *  3. Rescue is a per-task CAS, never a read-then-write. The lapsed predicate
 *     sits INSIDE the findOneAndUpdate filter, so a claimant renewing between
 *     the sweep's read and its write wins and the sweep loses — @sprint-review
 *     caught exactly this clobber in the first rescue design, where the sweep
 *     period equalled the lease and the race ran on every cycle.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Task = require('../models/Task');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { AgentInstallation } = require('../models/AgentRegistry');

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { deriveAgentState } = require('./agentStateService');

const KERNEL_ACTOR = 'kernel-sweep';
const TASK_CLAIM_LEASE_MS = 30 * 60 * 1000;

// #1080 part 2 (fable's ruling): "The rescue consults deriveAgentState: dead
// seat -> rescue as today; live seat -> defer one sweep period and warn the
// holder, at most three deferrals — liveness isn't tenure."
//
// LIVE means one state and one only. `deriveAgentState` returns five, and only
// `listening` is backed by evidence: for BYO/wrapper installs the seat polls
// every ~5s, so a fresh `lastUsedAt` is a measurement. The other four are not
// the opposite of live, they are differently-shaped:
//   - 'reachable' is asserted BY CONSTRUCTION for native + push-webhook
//     installs. Deferring on it would defer forever on a class whose liveness
//     was never checked.
//   - 'unknown' is the gateway/cloud tier saying so out loud (one shared boot
//     timestamp for a whole fleet). Deferring on an explicit "we don't know"
//     converts an honest abstention into a tenure grant.
// So both rescue as today. That is a READING of the ruling, not a quote from
// it, and it is the one place this implementation had to choose: the ruling
// says dead-vs-live and the derivation has a third answer. It fixes all three
// cases fable named — TASK-008, TASK-029 and TASK-015 are wrapper seats and
// derive 'listening' — while changing nothing for classes we cannot measure.
const LIVE_STATES = new Set(['listening']);

// "at most three deferrals" — verbatim. Per LEASE, not per task: the claim
// route resets the counter, so this bounds one holder's silence at
// 3 x SWEEP_INTERVAL_MS (~30 min) past a lapsed lease, never a task's lifetime.
const MAX_RESCUE_DEFERRALS = 3;

// MUST match the cron cadence in schedulerService ('4,14,24,... * * * *' =
// every 10 minutes). The newly-actionable window is one sweep period: wider
// re-wakes standing stock, narrower drops rows that landed between passes.
// If the cron cadence changes, this changes with it — they are one decision.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// How many found items a wake names inline. More than this and the wake stops
// being "here is your work" and becomes a report; the seat can list the board
// itself once it knows there is a reason to.
const MAX_NAMED_ITEMS = 5;

interface SweepResult {
  scannedPods: number;
  rescued: number;
  /** Lapsed rows left alone this pass because their holder is provably live. */
  deferred: number;
  woken: number;
  skippedNoWork: number;
}

interface TaskRow {
  _id: unknown;
  podId: unknown;
  taskId?: string;
  title?: string;
  status?: string;
  assignee?: string | null;
  claimedBy?: string | null;
  rescueDeferrals?: number;
  lapsedFrom?: string | null;
}

interface HolderIdentity {
  agentName: string;
  instanceId: string;
  /** Display label for the audit trail and the found-work wake. */
  label: string;
  /** `deriveAgentState`'s answer, or 'unknown' when the holder is unresolvable. */
  state: string;
}

/**
 * Who holds this lease, and can we prove they are alive?
 *
 * `claimedBy` is written by the claim route as
 * `resolveAgentInstanceId(req) || userId.toString()`. In practice it is almost
 * always the second branch: `resolveAgentInstanceId` reads `req.user.isBot`,
 * and the agent runtime auth middleware populates `req.agentUser` rather than
 * `req.user` (the documented gotcha in CLAUDE.md), so wrapper and MCP seats
 * fall through to their bot User's ObjectId. Both shapes are handled — the
 * id path first because it is the one live data actually uses.
 *
 * Returns null when the holder cannot be resolved to an install at all, which
 * the caller treats as "not provably live" and rescues as today. An
 * unresolvable holder is exactly the case the rescue exists for.
 */
const resolveHolder = async (
  podId: unknown,
  claimedBy: string | null | undefined,
  assignee: string | null | undefined,
  now: Date,
): Promise<HolderIdentity | null> => {
  if (!claimedBy) return null;
  try {
    const isObjectId = /^[0-9a-f]{24}$/i.test(claimedBy);
    const holder = isObjectId
      ? await User.findById(claimedBy).select('username isBot botMetadata agentRuntimeTokens').lean()
      : null;

    const agentName = String(holder?.botMetadata?.agentName || '').toLowerCase();
    const instanceId = String(holder?.botMetadata?.instanceId || (isObjectId ? 'default' : claimedBy));
    const label = assignee || holder?.username || claimedBy;

    const query: Record<string, unknown> = { podId: String(podId), status: 'active' };
    if (agentName) query.agentName = agentName;
    query.instanceId = instanceId;
    const install = await AgentInstallation.findOne(query)
      .select('agentName instanceId displayName installedBy config runtimeTokens')
      .lean();
    if (!install) return { agentName, instanceId, label, state: 'unknown' };

    const derived = deriveAgentState(install, holder?.agentRuntimeTokens || [], '', now.getTime());
    return {
      agentName: derived.agentName || agentName,
      instanceId: derived.instanceId || instanceId,
      label,
      state: derived.state,
    };
  } catch (err) {
    // Liveness is an optimization on top of the rescue, never a gate in front
    // of it. If the lookup throws, the row rescues as it did before #1080.
    console.warn('[kernel-sweep] holder lookup failed:', (err as Error).message);
    return null;
  }
};

class KernelWorkSweepService {
  /**
   * The lapsed-lease predicate, matching the claim CAS's two expiry branches
   * (tasksApi.claimableConditions). Duplicated as data rather than imported
   * because importing the route module here would drag express middleware into
   * the scheduler. The contract pin lives in
   * __tests__/unit/services/kernelWorkSweepService.test.js ("lapsed contract"):
   * a SUBSET assertion — these two branches deep-equal the last two entries of
   * claimableConditions(now) — because the shapes are deliberately not equal
   * (the claim CAS also admits pending and self-renewal). Mutation-probed red
   * before it shipped; see the PR body.
   */
  static lapsedConditions(now: Date): Record<string, unknown>[] {
    return [
      { status: 'claimed', claimExpiresAt: { $lt: now } },
      { status: 'claimed', claimExpiresAt: null, claimedAt: { $lt: new Date(now.getTime() - TASK_CLAIM_LEASE_MS) } },
    ];
  }

  /**
   * Rescue every lapsed lease back to `pending`, one CAS per task.
   *
   * Clearing the assignee is NOT optional (@pod-architect, #1023): status
   * alone returns the task to the lane of the seat that died holding it,
   * where no other seat's assignee-scoped fetch will ever see it.
   */
  static async rescueLapsed(now: Date): Promise<{ rescued: TaskRow[]; deferred: TaskRow[] }> {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { notifyLeaseWarning } = require('./taskEventService');

    const candidates = await Task.find({ $or: KernelWorkSweepService.lapsedConditions(now) })
      .select('_id podId taskId title status assignee claimedBy rescueDeferrals')
      .lean() as TaskRow[];

    const rescued: TaskRow[] = [];
    const deferred: TaskRow[] = [];
    for (const t of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const holder = await resolveHolder(t.podId, t.claimedBy, t.assignee, now);
      const used = Number(t.rescueDeferrals || 0);
      const canDefer = !!holder && LIVE_STATES.has(holder.state) && used < MAX_RESCUE_DEFERRALS;

      if (canDefer) {
        // Defer, warn, and count — one CAS, same lapsed predicate in the
        // filter. A holder who renews between the find and this write wins and
        // the deferral is simply not recorded, which is the correct outcome:
        // there is nothing left to defer.
        //
        // The counter increments even though the lease is NOT extended. That
        // is deliberate and it is what "liveness isn't tenure" buys: the row
        // stays lapsed and claimable by the CAS's own expiry branch the whole
        // time, so a peer who genuinely needs it can still take it. Deferral
        // suppresses the KERNEL's rescue, not the board.
        // eslint-disable-next-line no-await-in-loop
        const held = await Task.findOneAndUpdate(
          { _id: t._id, $or: KernelWorkSweepService.lapsedConditions(now) },
          {
            $set: { rescueDeferrals: used + 1 },
            $push: {
              updates: {
                text: `Lease lapsed but ${holder.label} is still listening — rescue deferred (${used + 1} of ${MAX_RESCUE_DEFERRALS}). Renew by posting a task update or re-claiming.`,
                author: KERNEL_ACTOR,
                authorId: null,
                createdAt: now,
              },
            },
          },
          { new: true },
        ) as TaskRow | null;
        if (held) {
          deferred.push(held);
          try {
            // eslint-disable-next-line no-await-in-loop
            await notifyLeaseWarning(t.podId, holder, held, used + 1, MAX_RESCUE_DEFERRALS, now);
          } catch (err) {
            // fable, 56213: "a dead seat ignoring it is the diagnosis, not the
            // failure." A warning that cannot be DELIVERED is neither — it is
            // just a missing signal, and it must not strand the row. The
            // deferral still stands; the next sweep re-evaluates.
            console.warn(`[kernel-sweep] lease warning failed for ${holder.label}:`, (err as Error).message);
          }
        }
        continue;
      }

      const provenance = holder?.label || t.assignee || t.claimedBy || null;
      const why = holder && LIVE_STATES.has(holder.state)
        ? ` after ${MAX_RESCUE_DEFERRALS} deferrals`
        : '';
      // eslint-disable-next-line no-await-in-loop
      const won = await Task.findOneAndUpdate(
        // The lapsed predicate travels INTO the filter: if the holder renewed
        // after our find, no branch matches and this is a no-op. The server
        // arbitrates, not our snapshot.
        { _id: t._id, $or: KernelWorkSweepService.lapsedConditions(now) },
        {
          $set: {
            status: 'pending',
            assignee: null,
            claimedBy: null,
            claimedAt: null,
            claimExpiresAt: null,
            rescueDeferrals: 0,
            // #1080 part 3: provenance always. The three fields that named the
            // owner are all cleared on the next four lines, which is what makes
            // the row findable again AND what made two reviewers hand-warn the
            // room that a finished PR was being re-advertised as unclaimed.
            // This field is the record that survives the clearing.
            lapsedFrom: provenance,
          },
          $push: {
            updates: {
              text: provenance
                ? `Lease lapsed — returned to pending by the kernel sweep${why} (was: ${provenance})`
                : `Lease lapsed — returned to pending by the kernel sweep${why}`,
              author: KERNEL_ACTOR,
              authorId: null,
              createdAt: now,
            },
          },
        },
        { new: true },
      ) as TaskRow | null;
      if (won) rescued.push(won);
    }
    return { rescued, deferred };
  }

  /**
   * One coalesced wake per opted-in seat, in pods that have actionable work —
   * and no event at all where there is none. The empty case costs zero model
   * turns, which is the entire point of the ruling.
   */
  static async wakeForFoundWork(now: Date): Promise<{ woken: number; skippedNoWork: number; scannedPods: number }> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { notifyFoundWork } = require('./taskEventService');

    // NEWLY actionable only — fable's gate one on this PR. Without the window,
    // newly-actionable is indistinguishable from standing stock, and a pod with
    // one unloved unassigned task gets a kernel wake EVERY pass, forever: the
    // turn-burner this service exists to kill, reborn one layer down. A task
    // every seat declined once is deliberately unclaimed; re-nagging is not
    // discovery. Rescued rows enter the window because the rescue's
    // findOneAndUpdate bumps updatedAt (Task has timestamps: true), so they
    // still need no separate channel.
    const since = new Date(now.getTime() - SWEEP_INTERVAL_MS);
    const actionable = await Task.aggregate([
      {
        $match: {
          status: 'pending',
          updatedAt: { $gte: since },
          $or: [{ assignee: null }, { assignee: '' }, { assignee: { $exists: false } }],
        },
      },
      // `lapsedFrom` rides along so the wake can name who it lapsed from
      // (#1080 part 3). The wake is the surface where the near-duplicate of
      // #1078 nearly happened: a row advertised as unassigned, with its
      // finished PR invisible because the rescue had cleared the assignee.
      { $group: { _id: '$podId', tasks: { $push: { taskId: '$taskId', title: '$title', lapsedFrom: '$lapsedFrom' } }, count: { $sum: 1 } } },
    ]) as Array<{ _id: unknown; tasks: Array<{ taskId?: string; title?: string; lapsedFrom?: string | null }>; count: number }>;

    let woken = 0;
    let skippedNoWork = 0;
    for (const pod of actionable) {
      // eslint-disable-next-line no-await-in-loop
      const result = await notifyFoundWork(pod._id, pod.tasks.slice(0, MAX_NAMED_ITEMS), pod.count, now);
      if (result.woken > 0) woken += result.woken; else skippedNoWork += 1;
    }
    return { woken, skippedNoWork, scannedPods: actionable.length };
  }

  static async sweep(now: Date = new Date()): Promise<SweepResult> {
    if (String(process.env.AGENT_WORK_SWEEP_DISABLED || '').toLowerCase() === 'true') {
      return {
        scannedPods: 0, rescued: 0, deferred: 0, woken: 0, skippedNoWork: 0,
      };
    }
    const { rescued, deferred } = await KernelWorkSweepService.rescueLapsed(now);
    const { woken, skippedNoWork, scannedPods } = await KernelWorkSweepService.wakeForFoundWork(now);
    if (rescued.length || deferred.length || woken) {
      console.log(`[kernel-sweep] rescued=${rescued.length} deferred=${deferred.length} woken=${woken} pods=${scannedPods}`);
    }
    return {
      scannedPods, rescued: rescued.length, deferred: deferred.length, woken, skippedNoWork,
    };
  }
}

// Re-exported so the wake path and any future consumer name the same actor.
export { KERNEL_ACTOR, LIVE_STATES, MAX_RESCUE_DEFERRALS };
export default KernelWorkSweepService;
// CJS compat: let require() return the class directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
