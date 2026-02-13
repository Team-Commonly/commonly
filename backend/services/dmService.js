const Pod = require('../models/Pod');
const { AgentInstallation } = require('../models/AgentRegistry');

let PGPod;
try {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
} catch (error) {
  PGPod = null;
}

class DMService {
  /**
   * Find or create a 1:1 agent-admin DM pod between an agent user and its
   * installer (the owner who installed the agent into a pod).
   */
  static async getOrCreateAgentDM(agentUserId, ownerUserId, { agentName, instanceId } = {}) {
    const agentId = String(agentUserId);
    const ownerId = String(ownerUserId);

    // Look for an existing agent-admin pod where both users are members and
    // the agent name matches (prevents cross-agent DM collisions).
    const existing = await Pod.findOne({
      type: 'agent-admin',
      members: { $all: [agentId, ownerId] },
      description: { $regex: `\\b${agentName}\\b`, $options: 'i' },
    });
    if (existing) return existing;

    // Fallback: broader search without description regex in case the
    // description was edited or stored differently.
    const fallback = await Pod.findOne({
      type: 'agent-admin',
      members: { $all: [agentId, ownerId] },
      name: { $regex: agentName, $options: 'i' },
    });
    if (fallback) return fallback;

    // Create a new DM pod
    const label = agentName || 'agent';
    const instanceSuffix = instanceId && instanceId !== 'default' ? ` (${instanceId})` : '';
    const dmPod = new Pod({
      name: `DM: ${label}${instanceSuffix}`,
      description: `Debug channel for ${label}${instanceSuffix}`,
      type: 'agent-admin',
      createdBy: ownerId,
      members: [agentId, ownerId],
    });
    await dmPod.save();

    // Sync to PostgreSQL
    try {
      if (process.env.PG_HOST && PGPod) {
        await PGPod.create(
          dmPod.name,
          dmPod.description,
          'agent-admin',
          ownerId,
          dmPod._id.toString(),
        );
        // Also add the agent user as a member in PG
        await PGPod.addMember(dmPod._id.toString(), agentId);
      }
    } catch (pgError) {
      console.error('Failed to sync DM pod to PostgreSQL:', pgError.message);
    }

    console.log(
      `[dm-service] Created agent-admin DM pod=${dmPod._id}`
      + ` agent=${agentName} owner=${ownerId}`,
    );

    return dmPod;
  }

  /**
   * Resolve the installer (owner) of a specific agent installation.
   * Returns the userId of the person who installed the agent, or null.
   */
  static async resolveAgentOwner(agentName, podId, instanceId = 'default') {
    const installation = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      podId,
      instanceId,
      status: { $in: ['active', 'paused'] },
    }).select('installedBy').lean();

    return installation?.installedBy || null;
  }
}

module.exports = DMService;
