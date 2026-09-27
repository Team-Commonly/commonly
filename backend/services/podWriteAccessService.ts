/**
 * "May this caller write into this pod?" — the shared membership gate for
 * per-pod write endpoints that accept BOTH human JWTs and agent runtime
 * tokens (reactions, thread follows, and anything added under `dualAuth`).
 *
 * Extracted from reactionController 2026-08-22 rather than copied. The two
 * bugs its comments record are both divergence bugs — the agent path checking
 * Mongo while the human path checked only the PG mirror, and the PG mirror
 * being lazily synced so 65 of 66 real members silently 403'd. A second copy
 * of this logic is how a third one happens.
 *
 * This is the WRITE gate and is deliberately not DMService.canViewPod, which
 * is the READ gate and carries an intentional admin bypass (§3.7) for ops
 * observability. Admins do not get to write into pods they have not joined.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */

export interface PodAccessReq {
  user?: { _id?: unknown };
  userId?: unknown;
  // Set by agentRuntimeAuth when the caller used a cm_agent_* token. NOT
  // req.user / req.userId — see the agent-runtime rule in CLAUDE.md.
  agentUser?: { _id?: unknown };
}

/** The one place that knows every shape a caller identity arrives in. */
export function getCallerId(req: PodAccessReq): string {
  return String(req.user?._id || req.userId || req.agentUser?._id || '');
}

/**
 * Returns true when the caller may write into the pod. For agent callers we
 * check AgentInstallation first (per "AgentInstallation required for posting"),
 * then fall back to Pod.members for agents installed via the runtime/room
 * handoff. For human callers Mongo `members` decides, and only Mongo: community
 * auto-join and several other join paths write Mongo only, and the PG
 * `pod_members` mirror can outlive the membership it mirrors — `PGPod.create`
 * inserts the owner unconditionally and `syncPodFromMongo` backfills Mongo's
 * `createdBy`, so 77 rows on production belong to pods whose Mongo `members` no
 * longer carry them, 36 of those the pod's own creator (Vera 74648, TASK-162).
 * A mirror is a fast path only while it cannot be wrong in the direction that
 * grants access.
 */
export async function callerHasPodWriteAccess(
  podId: string,
  userId: string,
  req: PodAccessReq,
): Promise<boolean> {
  const { isListedPodMember } = require('../utils/isPodMember');
  const Pod = require('../models/Pod');

  if (req.agentUser?._id) {
    const { AgentInstallation } = require('../models/AgentRegistry');
    const installation = await AgentInstallation.findOne({
      podId,
      installedBy: req.agentUser._id,
      status: 'active',
    }).lean();
    if (installation) return true;
    const pod = await Pod.findById(podId).select('members').lean();
    return isListedPodMember(pod, userId);
  }

  // No PG read here on purpose. The mirror used to be checked first, and a
  // stale positive is the whole defect: a row that survives a leave concluded
  // membership for a caller the pod's own write path refuses.
  const pod = await Pod.findById(podId).select('members').lean();
  return isListedPodMember(pod, userId);
}

module.exports = { getCallerId, callerHasPodWriteAccess };
Object.assign(module.exports, exports);
