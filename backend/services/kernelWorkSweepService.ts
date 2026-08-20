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

const KERNEL_ACTOR = 'kernel-sweep';
const TASK_CLAIM_LEASE_MS = 30 * 60 * 1000;

// How many found items a wake names inline. More than this and the wake stops
// being "here is your work" and becomes a report; the seat can list the board
// itself once it knows there is a reason to.
const MAX_NAMED_ITEMS = 5;

interface SweepResult {
  scannedPods: number;
  rescued: number;
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
}

class KernelWorkSweepService {
  /**
   * The lapsed-lease predicate, matching the claim CAS's two expiry branches
   * (tasksApi.claimableConditions). Duplicated as data rather than imported
   * because importing the route module here would drag express middleware into
   * the scheduler; the contract test in tasksApi's suite pins the two shapes
   * together the same way the CLI/backend mention lists are pinned.
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
  static async rescueLapsed(now: Date): Promise<TaskRow[]> {
    const candidates = await Task.find({ $or: KernelWorkSweepService.lapsedConditions(now) })
      .select('_id podId taskId title status assignee claimedBy')
      .lean() as TaskRow[];

    const rescued: TaskRow[] = [];
    for (const t of candidates) {
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
          },
          $push: {
            updates: {
              text: 'Lease lapsed — returned to pending by the kernel sweep',
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
    return rescued;
  }

  /**
   * One coalesced wake per opted-in seat, in pods that have actionable work —
   * and no event at all where there is none. The empty case costs zero model
   * turns, which is the entire point of the ruling.
   */
  static async wakeForFoundWork(now: Date): Promise<{ woken: number; skippedNoWork: number; scannedPods: number }> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { notifyFoundWork } = require('./taskEventService');

    // Pods with any actionable row: pending+unassigned. (Just-rescued rows are
    // pending+unassigned by construction, so they are covered here without a
    // separate channel.)
    const actionable = await Task.aggregate([
      { $match: { status: 'pending', $or: [{ assignee: null }, { assignee: '' }, { assignee: { $exists: false } }] } },
      { $group: { _id: '$podId', tasks: { $push: { taskId: '$taskId', title: '$title' } }, count: { $sum: 1 } } },
    ]) as Array<{ _id: unknown; tasks: Array<{ taskId?: string; title?: string }>; count: number }>;

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
      return { scannedPods: 0, rescued: 0, woken: 0, skippedNoWork: 0 };
    }
    const rescued = await KernelWorkSweepService.rescueLapsed(now);
    const { woken, skippedNoWork, scannedPods } = await KernelWorkSweepService.wakeForFoundWork(now);
    if (rescued.length || woken) {
      console.log(`[kernel-sweep] rescued=${rescued.length} woken=${woken} pods=${scannedPods}`);
    }
    return { scannedPods, rescued: rescued.length, woken, skippedNoWork };
  }
}

// Re-exported so the wake path and any future consumer name the same actor.
export { KERNEL_ACTOR };
export default KernelWorkSweepService;
// CJS compat: let require() return the class directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
