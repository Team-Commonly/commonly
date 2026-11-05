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
  // Set by auth.ts when a bot User authenticated with a cm_ user/device token
  // and so arrives on the human branch (F149).
  botCaller?: { username?: unknown; botMetadata?: { agentName?: unknown; instanceId?: unknown } };
}

/** The installations agentRuntimeAuth resolved for the token's agent identity. */
export interface AgentInstallationsReq {
  agentInstallations?: Array<{ podId?: unknown; status?: unknown }>;
}

/** The one place that knows every shape a caller identity arrives in. */
export function getCallerId(req: PodAccessReq): string {
  return String(req.user?._id || req.userId || req.agentUser?._id || '');
}

/**
 * Returns true when the caller may write into the pod.
 *
 * Agent callers (`req.agentUser`, set by agentRuntimeAuth) are decided by the
 * agent's OWN active AgentInstallation in this pod — the rows agentRuntimeAuth
 * resolved for the token's identity (`req.agentInstallations`). `Pod.members`
 * is not consulted for them, with one exception below. Until F149 this looked
 * the installation up by `installedBy: agentUser._id`; `installedBy` is the
 * HUMAN who installed the agent, so the lookup missed and every agent fell
 * through to `Pod.members`, a row an uninstall can leave behind.
 *
 * The exception is the agent's admin DM (`agent-admin`), which carries no
 * installation: membership there is the rule, as it is for the runtime post
 * path (agentRuntimeAuth's `agentAuthorizedPodIds`).
 *
 * For human callers Mongo `members` decides, and only Mongo: community
 * auto-join and several other join paths write Mongo only, and the PG
 * `pod_members` mirror can outlive the membership it mirrors — `PGPod.create`
 * inserts the owner unconditionally and `syncPodFromMongo` backfills Mongo's
 * `createdBy`, so 77 rows on production belong to pods whose Mongo `members` no
 * longer carry them, 36 of those the pod's own creator (Vera 74648, TASK-162).
 * A mirror is a fast path only while it cannot be wrong in the direction that
 * grants access. A bot User on that branch (a cm_ user token, `req.botCaller`)
 * needs the members row AND an active installation for its own identity.
 */
export async function callerHasPodWriteAccess(
  podId: string,
  userId: string,
  req: PodAccessReq & AgentInstallationsReq,
): Promise<boolean> {
  const { isListedPodMember } = require('../utils/isPodMember');
  const Pod = require('../models/Pod');

  if (req.agentUser?._id) {
    if (agentHoldsActiveInstallationInPod(podId, req)) return true;
    const pod = await Pod.findById(podId).select('type members').lean();
    return pod?.type === 'agent-admin' && isListedPodMember(pod, userId);
  }

  // No PG read here on purpose. The mirror used to be checked first, and a
  // stale positive is the whole defect: a row that survives a leave concluded
  // membership for a caller the pod's own write path refuses.
  const pod = await Pod.findById(podId).select('members').lean();
  if (!isListedPodMember(pod, userId)) return false;
  // A bot User with a cm_ user token is on this branch too, and a members row
  // can outlive its uninstall here just as on the agent branch. It must also
  // hold an active installation in the pod under its OWN identity, resolved
  // the way agentRuntimeAuth resolves a runtime token's (F149).
  if (req.botCaller) return botHoldsActiveInstallationInPod(podId, req.botCaller);
  return true;
}

async function botHoldsActiveInstallationInPod(
  podId: string,
  botCaller: NonNullable<PodAccessReq['botCaller']>,
): Promise<boolean> {
  const { resolveTokenAgentIdentity } = require('../utils/agentTokenIdentity');
  const { installationIdentityFilter } = require('./agentInstallationIdentity');
  const { AgentInstallation } = require('../models/AgentRegistry');
  const { agentName, instanceId } = resolveTokenAgentIdentity(botCaller);
  if (!agentName) return false;
  const installation = await AgentInstallation.exists({
    ...installationIdentityFilter(agentName, instanceId),
    podId,
    status: 'active',
  });
  return Boolean(installation);
}

/**
 * Does an agent caller hold an ACTIVE AgentInstallation in this pod?
 *
 * The agent half of `callerHasPodWriteAccess` (F149), also asked directly by
 * F141's delete, which must not take the gate's agent-admin membership
 * exception. Reads the installations agentRuntimeAuth
 * resolved for this request (`status: 'active'`, the token's agent identity),
 * so it is a lookup on the request, not a second query shape.
 *
 * False for a human caller: humans have no installations. Callers branch on
 * `req.agentUser` before asking.
 */
export function agentHoldsActiveInstallationInPod(
  podId: string,
  req: PodAccessReq & AgentInstallationsReq,
): boolean {
  if (!req.agentUser?._id) return false;
  return (req.agentInstallations || []).some((installation) => (
    String(installation?.podId || '') === String(podId)
    && (installation?.status === undefined || installation.status === 'active')
  ));
}

module.exports = { getCallerId, callerHasPodWriteAccess, agentHoldsActiveInstallationInPod };
Object.assign(module.exports, exports);
