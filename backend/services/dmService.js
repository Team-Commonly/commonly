const Pod = require('../models/Pod');
const User = require('../models/User');
const { AgentInstallation } = require('../models/AgentRegistry');

let PGPod;
try {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
} catch (error) {
  PGPod = null;
}

class DMService {
  static escapeRegex(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  static async syncPgDmMembers(dmPodId, ownerId, agentId) {
    try {
      if (process.env.PG_HOST && PGPod) {
        await PGPod.addMember(dmPodId, ownerId);
        await PGPod.addMember(dmPodId, agentId);
      }
    } catch (pgError) {
      console.error('Failed to sync DM pod members to PostgreSQL:', pgError.message);
    }
  }

  static async ensureDmMembers(dmPod, ownerId, agentId) {
    const existingMembers = new Set(
      (dmPod.members || []).map((member) => String(member?._id || member)),
    );
    const missingOwner = !existingMembers.has(String(ownerId));
    const missingAgent = !existingMembers.has(String(agentId));
    if (!missingOwner && !missingAgent) {
      return dmPod;
    }

    dmPod.members = Array.from(new Set([
      ...Array.from(existingMembers),
      String(ownerId),
      String(agentId),
    ]));
    await dmPod.save();
    await DMService.syncPgDmMembers(dmPod._id.toString(), ownerId, agentId);
    return dmPod;
  }

  static async isCompatibleStalePod(dmPod, ownerId, agentId) {
    const ownerIdStr = String(ownerId);
    const agentIdStr = String(agentId);
    const otherMemberIds = (dmPod.members || [])
      .map((member) => String(member?._id || member))
      .filter((id) => id !== ownerIdStr);

    if (!otherMemberIds.length) return true;

    const botMembers = await User.find({
      _id: { $in: otherMemberIds },
      isBot: true,
    }).select('_id').lean();

    if (!botMembers.length) return true;

    return botMembers.some((member) => String(member._id) === agentIdStr);
  }

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
    if (existing) return DMService.ensureDmMembers(existing, ownerId, agentId);

    // Fallback: broader search without description regex in case the
    // description was edited or stored differently.
    const fallback = await Pod.findOne({
      type: 'agent-admin',
      members: { $all: [agentId, ownerId] },
      name: { $regex: agentName, $options: 'i' },
    });
    if (fallback) return DMService.ensureDmMembers(fallback, ownerId, agentId);

    // Repair stale pods that match this agent hint but are missing one of the
    // expected members (for example older records with owner-only membership).
    const safeAgentName = DMService.escapeRegex(agentName || 'agent');
    const staleCandidates = await Pod.find({
      type: 'agent-admin',
      members: ownerId,
      $or: [
        { description: { $regex: `\\b${safeAgentName}\\b`, $options: 'i' } },
        { name: { $regex: safeAgentName, $options: 'i' } },
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(5);
    const staleChecks = await Promise.all(
      staleCandidates.map(async (candidate) => ({
        candidate,
        compatible: await DMService.isCompatibleStalePod(candidate, ownerId, agentId),
      })),
    );
    const stale = staleChecks.find((row) => row.compatible)?.candidate || null;
    if (stale) {
      return DMService.ensureDmMembers(stale, ownerId, agentId);
    }

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
        // Ensure both members exist in PG.
        await DMService.syncPgDmMembers(dmPod._id.toString(), ownerId, agentId);
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

  /**
   * Find or create the single shared DM pod for a given agent instance.
   * Members: agent + installer/owner + all admin users.
   * All members are treated as a unified admin/owner group — the agent does not
   * distinguish between individual admins. Idempotent: new admins or a changed
   * installer are merged in on every call (e.g. reprovision).
   */
  static async getOrCreateAdminDMPod(agentUserId, installerUserId, { agentName, instanceId } = {}) {
    const agentId = String(agentUserId);
    const label = agentName || 'agent';
    const instanceSuffix = instanceId && instanceId !== 'default' ? `:${instanceId}` : '';
    const podName = `Admin: ${label}${instanceSuffix}`;

    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    const adminIds = admins.map((a) => String(a._id));
    // Include the installer even if they are not an admin (community-installed agents).
    const installerId = installerUserId ? String(installerUserId) : null;
    const allExpectedIds = [...new Set([agentId, ...adminIds, ...(installerId ? [installerId] : [])])];

    // Look for the existing shared DM pod by canonical name.
    const existing = await Pod.findOne({
      type: 'agent-admin',
      members: agentId,
      name: podName,
    });

    if (existing) {
      // Merge in any members missing since the pod was created (new admins, changed installer).
      const existingMemberStrings = existing.members.map(String);
      const missing = allExpectedIds.filter((id) => !existingMemberStrings.includes(id));
      if (missing.length > 0) {
        existing.members.push(...missing);
        await existing.save();
        try {
          if (process.env.PG_HOST && PGPod) {
            await Promise.all(missing.map((id) => PGPod.addMember(existing._id.toString(), id)));
          }
        } catch (pgError) {
          console.error('Failed to sync new members to PostgreSQL:', pgError.message);
        }
      }
      return existing;
    }

    // Create the shared DM pod.
    const creatorId = installerId || adminIds[0] || agentId;
    const dmPod = new Pod({
      name: podName,
      description: `Admin & owner channel for ${label}${instanceSuffix}`,
      type: 'agent-admin',
      createdBy: creatorId,
      members: allExpectedIds,
    });
    await dmPod.save();

    try {
      if (process.env.PG_HOST && PGPod) {
        await PGPod.create(
          dmPod.name,
          dmPod.description,
          'agent-admin',
          creatorId,
          dmPod._id.toString(),
        );
        await Promise.all(allExpectedIds.map((id) => PGPod.addMember(dmPod._id.toString(), id)));
      }
    } catch (pgError) {
      console.error('Failed to sync admin DM pod to PostgreSQL:', pgError.message);
    }

    console.log(
      `[dm-service] Created shared admin DM pod=${dmPod._id}`
      + ` agent=${agentName} members=${allExpectedIds.length}`,
    );

    return dmPod;
  }
}

module.exports = DMService;
