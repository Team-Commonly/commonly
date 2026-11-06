import Pod from '../models/Pod';
import User from '../models/User';
import { AgentInstallation } from '../models/AgentRegistry';
import AgentIdentityService, { DM_POD_TYPES_GUARD } from './agentIdentityService';
import { installationIdentityFilter } from './agentInstallationIdentity';
import { isHostedInstallation } from './hostedRuntimeService';

const IDENTITY_COLLATION = { locale: 'en', strength: 2 };

/**
 * A DM's row counts as an install, so an agent removed from its last pod kept
 * its token and kept answering in DMs, with no pod left for its owner to remove
 * it from. This ends those rows, so the caller's last-uninstall revoke fires.
 * An owner still in a DM with the agent keeps it: that DM is theirs to end, and
 * only then do the rest go, so a guest can't end anyone else's. With no owner
 * on record nothing changes. Hosted agents are owner-scoped: see
 * retireHostedRoomRows. Runs after the removed row is uninstalled, before the
 * revoke. Installing the agent in a pod again brings these rows back.
 * Never throws: the removal has already happened.
 */
export const retireDmRowsWithAgent = async (
  agentName: string, instanceId: string, removedPodId: unknown,
): Promise<number> => {
  try {
    const type = AgentIdentityService.resolveAgentType(agentName);
    const agent: any = await User.findOne({ username: AgentIdentityService.buildAgentUsername(type, instanceId), isBot: true })
      .select('botMetadata.ownerUserId').lean();
    const ownerId = agent?.botMetadata?.ownerUserId ? String(agent.botMetadata.ownerUserId) : null;
    if (!ownerId) return 0;

    const lower = String(agentName).toLowerCase();
    const rows: any[] = await AgentInstallation.find({
      ...installationIdentityFilter(lower, String(instanceId || 'default').toLowerCase()),
      agentName: { $in: [...new Set([lower, type])] },
      status: { $in: ['active', 'paused'] },
    }).collation(IDENTITY_COLLATION).select('podId config.runtime').lean();
    if (!rows.length || rows.some((row) => isHostedInstallation(row))) return 0;

    const pods: any[] = await Pod.find({ _id: { $in: [removedPodId, ...rows.map((row) => row.podId)] } })
      .select('type members').lean();
    const isDm = (pod: any) => DM_POD_TYPES_GUARD.has(pod.type);
    const holdsOwner = (pod: any) => (pod.members || []).some((m: any) => String(m?.userId || m) === ownerId);
    const removed = pods.find((pod) => String(pod._id) === String(removedPodId));
    if (removed && isDm(removed) && !holdsOwner(removed)) return 0;
    const standing = pods.filter((pod) => pod !== removed);
    if (standing.some((pod) => !isDm(pod) || holdsOwner(pod))) return 0;

    await AgentInstallation.updateMany(
      { _id: { $in: rows.map((row) => row._id) } },
      { $set: { status: 'uninstalled', retiredWithAgentAt: new Date() } },
    );
    return rows.length;
  } catch (error) {
    console.warn('[agent-dm] ending the DM rows of a removed agent failed:', (error as Error).message);
    return 0;
  }
};
