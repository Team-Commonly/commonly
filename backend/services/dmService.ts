import Pod from '../models/Pod';
import User from '../models/User';
import { AgentInstallation } from '../models/AgentRegistry';

let PGPod: { addMember: (podId: string, userId: unknown) => Promise<void>; create: (name: string, description: string, type: string, creatorId: unknown, podId: string) => Promise<void> } | null;
try {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
} catch (error) {
  PGPod = null;
}

interface DMOptions {
  agentName?: string;
  instanceId?: string;
}

class DMService {
  static escapeRegex(value = ''): string {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  static async syncPgDmMembers(dmPodId: string, ownerId: unknown, agentId: unknown): Promise<void> {
    try {
      if (process.env.PG_HOST && PGPod) {
        await PGPod.addMember(dmPodId, ownerId);
        await PGPod.addMember(dmPodId, agentId);
      }
    } catch (pgError) {
      console.error('Failed to sync DM pod members to PostgreSQL:', (pgError as Error).message);
    }
  }

  static async ensureDmMembers(dmPod: InstanceType<typeof Pod>, ownerId: unknown, agentId: unknown): Promise<InstanceType<typeof Pod>> {
    const existingMembers = new Set(
      (dmPod.members || []).map((member: unknown) => String((member as unknown as Record<string, unknown>)?._id || member)),
    );
    const missingOwner = !existingMembers.has(String(ownerId));
    const missingAgent = !existingMembers.has(String(agentId));
    if (!missingOwner && !missingAgent) {
      return dmPod;
    }

    (dmPod as unknown as Record<string, unknown>).members = Array.from(new Set([
      ...Array.from(existingMembers),
      String(ownerId),
      String(agentId),
    ]));
    await dmPod.save();
    await DMService.syncPgDmMembers(dmPod._id.toString(), ownerId, agentId);
    return dmPod;
  }

  static async isCompatibleStalePod(dmPod: InstanceType<typeof Pod>, ownerId: unknown, agentId: unknown): Promise<boolean> {
    const ownerIdStr = String(ownerId);
    const agentIdStr = String(agentId);
    const otherMemberIds = (dmPod.members || [])
      .map((member: unknown) => String((member as unknown as Record<string, unknown>)?._id || member))
      .filter((id: string) => id !== ownerIdStr);

    if (!otherMemberIds.length) return true;

    const botMembers = await User.find({
      _id: { $in: otherMemberIds },
      isBot: true,
    }).select('_id').lean();

    if (!botMembers.length) return true;

    return botMembers.some((member) => String((member as unknown as Record<string, unknown>)._id) === agentIdStr);
  }

  /**
   * Find or create a 1:1 agent-admin DM pod between an agent user and its
   * installer (the owner who installed the agent into a pod).
   */
  static async getOrCreateAgentDM(agentUserId: unknown, ownerUserId: unknown, { agentName, instanceId }: DMOptions = {}): Promise<InstanceType<typeof Pod>> {
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
      joinPolicy: 'invite-only',
      createdBy: ownerId,
      members: [agentId, ownerId],
    });
    await dmPod.save();

    // Sync to PostgreSQL
    try {
      if (process.env.PG_HOST && PGPod) {
        await PGPod.create(
          dmPod.name,
          dmPod.description || '',
          'agent-admin',
          ownerId,
          dmPod._id.toString(),
        );
        // Ensure both members exist in PG.
        await DMService.syncPgDmMembers(dmPod._id.toString(), ownerId, agentId);
      }
    } catch (pgError) {
      console.error('Failed to sync DM pod to PostgreSQL:', (pgError as Error).message);
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
  static async resolveAgentOwner(agentName: string, podId: unknown, instanceId = 'default'): Promise<unknown | null> {
    const installation = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      podId,
      instanceId,
      status: { $in: ['active', 'paused'] },
    }).select('installedBy').lean();

    return (installation as unknown as Record<string, unknown> | null)?.installedBy || null;
  }

  /**
   * Find or create the single shared DM pod for a given agent instance.
   * Members: agent + installer/owner + all admin users.
   * All members are treated as a unified admin/owner group — the agent does not
   * distinguish between individual admins. Idempotent: new admins or a changed
   * installer are merged in on every call (e.g. reprovision).
   */
  static async getOrCreateAdminDMPod(agentUserId: unknown, installerUserId: unknown, { agentName, instanceId }: DMOptions = {}): Promise<InstanceType<typeof Pod>> {
    const agentId = String(agentUserId);
    const label = agentName || 'agent';
    const instanceSuffix = instanceId && instanceId !== 'default' ? `:${instanceId}` : '';
    const podName = `Admin: ${label}${instanceSuffix}`;

    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    const adminIds = admins.map((a) => String((a as unknown as Record<string, unknown>)._id));
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
        (existing.members as unknown as string[]).push(...missing);
        await existing.save();
        try {
          if (process.env.PG_HOST && PGPod) {
            await Promise.all(missing.map((id) => PGPod!.addMember(existing._id.toString(), id)));
          }
        } catch (pgError) {
          console.error('Failed to sync new members to PostgreSQL:', (pgError as Error).message);
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
      joinPolicy: 'invite-only',
      createdBy: creatorId,
      members: allExpectedIds,
    });
    await dmPod.save();

    try {
      if (process.env.PG_HOST && PGPod) {
        await PGPod.create(
          dmPod.name,
          dmPod.description || '',
          'agent-admin',
          creatorId,
          dmPod._id.toString(),
        );
        await Promise.all(allExpectedIds.map((id) => PGPod!.addMember(dmPod._id.toString(), id)));
      }
    } catch (pgError) {
      console.error('Failed to sync admin DM pod to PostgreSQL:', (pgError as Error).message);
    }

    console.log(
      `[dm-service] Created shared admin DM pod=${dmPod._id}`
      + ` agent=${agentName} members=${allExpectedIds.length}`,
    );

    return dmPod;
  }
  /**
   * Find or create an agent-room pod for a given agent. Agent rooms are
   * personal 1:1 DMs (ADR-001 §3.10) — one user, one agent, no third
   * party. The original "pro agent's office" framing (N humans × 1 agent)
   * was rejected during product review; agent-rooms are strictly 1:1 and
   * the join/auto-install paths in podController/agentIdentityService
   * enforce that invariant. For multi-party human↔agent surfaces, use
   * `type: 'chat'`. The legacy `type: 'agent-admin'` (multi-admin debug
   * channel) is separate and slated for deprecation.
   *
   * If the requesting user already has an agent room with this agent, the
   * existing pod is returned. Otherwise a new one is created.
   */
  static async getOrCreateAgentRoom(agentUserId: unknown, requestingUserId: unknown, { agentName, instanceId }: DMOptions = {}): Promise<InstanceType<typeof Pod>> {
    const agentId = String(agentUserId);
    const userId = String(requestingUserId);
    const label = agentName || 'agent';
    const instanceSuffix = instanceId && instanceId !== 'default' ? ` (${instanceId})` : '';

    // Look for an existing agent-room pod where both the agent and the user
    // are members. This finds rooms this user already opened with the agent.
    const existing = await Pod.findOne({
      type: 'agent-room',
      members: { $all: [agentId, userId] },
    });
    if (existing) return existing;

    // Create a new agent-room pod. The agent is the conceptual "host" — listed
    // first in members and set as createdBy so the UI can display the agent's
    // avatar in the pod header.
    const roomPod = new Pod({
      name: `${label}${instanceSuffix}`,
      description: `Agent room — talk with ${label}`,
      type: 'agent-room',
      joinPolicy: 'invite-only',
      createdBy: agentId,
      members: [agentId, userId],
    });
    await roomPod.save();

    // Sync to PostgreSQL
    try {
      if (process.env.PG_HOST && PGPod) {
        await PGPod.create(
          roomPod.name,
          roomPod.description || '',
          'agent-room',
          agentId,
          roomPod._id.toString(),
        );
        await PGPod.addMember(roomPod._id.toString(), agentId);
        await PGPod.addMember(roomPod._id.toString(), userId);
      }
    } catch (pgError) {
      console.error('Failed to sync agent-room pod to PostgreSQL:', (pgError as Error).message);
    }

    // Create the AgentInstallation so the agent can post back into the pod.
    // pod.members membership routes incoming events TO the agent, but
    // outbound POST /messages is gated by `agentRuntimeAuth` against
    // AgentInstallation — agents in pod.members without an install get
    // 403, the gateway swallows it, and replies vanish silently. Memory
    // `agent-runtime` documents this: "AgentInstallation required for
    // posting." Heartbeat:enabled=false because agent-rooms are reactive
    // (they fire on user message, not on a schedule).
    if (agentName) {
      try {
        await AgentInstallation.install(agentName.toLowerCase(), roomPod._id, {
          version: '1.0.0',
          config: {
            heartbeat: { enabled: false },
            autoJoinSource: 'agent-room-create',
          } as unknown as Map<string, unknown>,
          scopes: ['context:read', 'summaries:read', 'messages:write'],
          installedBy: requestingUserId as unknown as import('mongoose').Types.ObjectId,
          instanceId: instanceId || 'default',
          displayName: `${label}${instanceSuffix}`,
        });
      } catch (installErr) {
        console.error(
          `[dm-service] AgentInstallation.install failed for agent-room pod=${roomPod._id}:`,
          (installErr as Error).message,
        );
      }
    }

    console.log(
      `[dm-service] Created agent-room pod=${roomPod._id}`
      + ` agent=${label} user=${userId}`,
    );

    return roomPod;
  }
}

export default DMService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
