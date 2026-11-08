import Pod from '../models/Pod';
import { IDENTITY_COLLATION, installationIdentityFilter } from './agentInstallationIdentity';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');

interface RoomInstallation {
  agentName?: string;
  instanceId?: string;
}

/**
 * The pod an agent room's Connect should open. The room's install is a copy,
 * and Bring your own lists neither DM pods nor public ones, so it would land on
 * another pod that may not hold the agent. This is the caller's oldest install
 * of the agent in a pod the page will accept, or null when there is none.
 *
 * The link is advisory: a failed read costs it, and the notice still shows.
 */
export async function connectPodFor(
  installation: RoomInstallation,
  callerId: string,
  roomPodId: string,
): Promise<string | null> {
  try {
    const homes = await AgentInstallation.find({
      ...installationIdentityFilter(
        String(installation.agentName || '').toLowerCase(),
        String(installation.instanceId || 'default').toLowerCase(),
      ),
      installedBy: callerId,
      status: 'active',
      podId: { $ne: roomPodId },
    }).select('podId').sort({ createdAt: 1 }).collation(IDENTITY_COLLATION).lean();
    const installable = await Pod.find({
      _id: { $in: homes.map((home: { podId: unknown }) => home.podId) },
      members: callerId,
      type: { $nin: ['agent-room', 'agent-dm', 'agent-admin'] },
      publicRead: { $ne: true },
    }).select('_id').lean();
    const ids = new Set(installable.map((pod) => String(pod._id)));
    const home = homes.find((candidate: { podId: unknown }) => ids.has(String(candidate.podId)));
    return home ? String(home.podId) : null;
  } catch (error) {
    console.warn('Could not resolve the room connect pod:', error);
    return null;
  }
}
