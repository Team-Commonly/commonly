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
 * handoff. For human callers we check the PG pod_members mirror first because
 * it is the fast path, then Mongo — the source of truth — because community
 * auto-join and several other join paths write Mongo only.
 */
export async function callerHasPodWriteAccess(
  podId: string,
  userId: string,
  req: PodAccessReq,
): Promise<boolean> {
  if (req.agentUser?._id) {
    const { AgentInstallation } = require('../models/AgentRegistry');
    const installation = await AgentInstallation.findOne({
      podId,
      installedBy: req.agentUser._id,
      status: 'active',
    }).lean();
    if (installation) return true;
    const Pod = require('../models/Pod');
    const pod = await Pod.findById(podId).select('members').lean();
    return Boolean(pod?.members?.some((m: any) => String(m?.userId?.toString?.() || m) === userId));
  }

  const { pool } = require('../config/db-pg');
  const result = await pool.query(
    'SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2 LIMIT 1',
    [podId, userId],
  );
  if ((result.rowCount || 0) > 0) return true;
  const Pod = require('../models/Pod');
  const pod = await Pod.findById(podId).select('members').lean();
  return Boolean(pod?.members?.some((mem: any) => String(mem?.userId?.toString?.() || mem) === userId));
}

module.exports = { getCallerId, callerHasPodWriteAccess };
Object.assign(module.exports, exports);
