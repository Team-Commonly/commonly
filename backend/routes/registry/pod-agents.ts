// Pod/agent management routes — extracted from registry.js (GH#112)
// Handles: list agents in pod, get single agent, uninstall agent
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const AgentTemplate = require('../../models/AgentTemplate');
const AgentEvent = require('../../models/AgentEvent');
const Pod = require('../../models/Pod');
const AgentIdentityService = require('../../services/agentIdentityService');
const {
  getUserId,
  isGlobalAdminUser,
  normalizeDisplayName,
  resolveInstallation,
  buildAgentProfileId,
  buildAgentInstallationPayload,
} = require('./helpers');

const podAgentsRouter = express.Router();

/**
 * DELETE /api/registry/agents/:name/pods/:podId
 * Uninstall an agent from a pod
 */
podAgentsRouter.delete('/agents/:name/pods/:podId', auth, async (req: any, res: any) => {
  try {
    const { name, podId } = req.params;
    const { installation, instanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: req.query.instanceId,
    });
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const isGlobalAdmin = await isGlobalAdminUser(userId);

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator && !isGlobalAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation) {
      if (!isCreator && !isGlobalAdmin) {
        return res.status(404).json({ error: 'Agent not installed in this pod' });
      }

      await AgentProfile.deleteOne({ agentId: buildAgentProfileId(name, instanceId), podId });
      try {
        const resolvedType = AgentIdentityService.resolveAgentType(name);
        await AgentIdentityService.removeAgentFromPod(
          AgentIdentityService.buildAgentUsername(resolvedType, instanceId),
          podId,
        );
      } catch (identityError: unknown) {
        console.warn('Failed to remove agent user from pod:', (identityError as Error).message);
      }

      return res.json({ success: true, removedOrphan: true });
    }

    const isInstaller = installation.installedBy?.toString?.() === userId.toString();

    if (!isCreator && !isInstaller && !isGlobalAdmin) {
      return res.status(403).json({ error: 'Only pod admins or installers can remove agents' });
    }

    await AgentInstallation.uninstall(name, podId, instanceId);
    await AgentProfile.deleteOne({ agentId: buildAgentProfileId(name, instanceId), podId });

    // ADR-006 OQ #1: ephemeral self-serve registry rows whose only
    // installation was just removed are leaked here. v1 punts; the GC
    // janitor lands when orphan-row volume warrants it.

    try {
      const resolvedType = AgentIdentityService.resolveAgentType(name);
      await AgentIdentityService.removeAgentFromPod(
        AgentIdentityService.buildAgentUsername(resolvedType, instanceId),
        podId,
      );
    } catch (identityError: unknown) {
      console.warn('Failed to remove agent user from pod:', (identityError as Error).message);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error uninstalling agent:', error);
    res.status(500).json({ error: 'Failed to uninstall agent' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents
 * List agents installed in a pod
 */
podAgentsRouter.get('/pods/:podId/agents', auth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    // §3.7 read-access: members + creator allowed; for agent-dm, anyone
    // sharing a pod with either bot member is also allowed.
    // eslint-disable-next-line global-require
    const DMService = require('../../services/dmService');
    const canView = await DMService.canViewPod(userId, pod);

    if (!canView && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const installations = await AgentInstallation.getInstalledAgents(podId);

    // Batch-fetch last heartbeat timestamp per agent/instance from agentevents
    const heartbeatRows = await AgentEvent.aggregate([
      {
        $match: {
          type: 'heartbeat',
          status: 'delivered',
          agentName: { $in: installations.map((i: any) => i.agentName) },
          instanceId: { $in: installations.map((i: any) => i.instanceId || 'default') },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { agentName: '$agentName', instanceId: '$instanceId' },
          lastHeartbeatAt: { $first: '$createdAt' },
        },
      },
    ]);
    const heartbeatMap = new Map(
      heartbeatRows.map((r: any) => [`${r._id.agentName}:${r._id.instanceId}`, r.lastHeartbeatAt]),
    );

    // Native agents never heartbeat and never use a runtime token — their
    // proof of life is AgentRun rows. Same key shape as heartbeatMap; uses
    // the { podId, agentName, instanceId, startedAt } index. Aggregation
    // $match does not cast, so podId must be an ObjectId (#915).
    let runRows: any[] = [];
    try {
      const AgentRun = require('../../models/AgentRun');
      const mongoose = require('mongoose');
      runRows = await AgentRun.aggregate([
        {
          $match: {
            podId: new mongoose.Types.ObjectId(String(podId)),
            agentName: { $in: installations.map((i: any) => i.agentName) },
          },
        },
        { $sort: { startedAt: -1 } },
        {
          $group: {
            _id: { agentName: '$agentName', instanceId: '$instanceId' },
            lastRunAt: { $first: '$startedAt' },
          },
        },
      ]);
    } catch (runErr) {
      // Activity enrichment is advisory — never fail the roster over it.
      console.warn('[pod-agents] AgentRun activity lookup failed:', (runErr as Error).message);
    }
    const runMap = new Map(
      runRows.map((r: any) => [`${r._id.agentName}:${r._id.instanceId || 'default'}`, r.lastRunAt]),
    );

    const registryEntries = await AgentRegistry.find({
      agentName: { $in: installations.map((i: any) => i.agentName) },
    }).select('agentName iconUrl').lean();
    const iconMap = new Map(registryEntries.map((entry: any) => [entry.agentName, entry.iconUrl || '']));
    const installationDisplayNames = Array.from(new Set(
      installations.map((i: any) => i.displayName).filter(Boolean),
    ));
    const templateCandidates = await AgentTemplate.find({
      agentName: { $in: installations.map((i: any) => i.agentName) },
      displayName: { $in: installationDisplayNames },
      $or: [
        { visibility: 'public' },
        { createdBy: userId },
        { createdBy: { $in: installations.map((i: any) => i.installedBy).filter(Boolean) } },
      ],
    }).select('agentName displayName iconUrl createdBy visibility').lean();
    const getTemplateIcon = (installation: any) => {
      const displayName = normalizeDisplayName(installation.displayName);
      if (!displayName) return '';
      const matches = templateCandidates.filter((template: any) => (
        template.agentName === installation.agentName
        && normalizeDisplayName(template.displayName) === displayName
        && template.iconUrl
      ));
      if (matches.length === 0) return '';
      const installedBy = installation.installedBy?.toString?.() || String(installation.installedBy || '');
      const exactOwner = matches.find((template: any) => String(template.createdBy || '') === installedBy);
      if (exactOwner) return exactOwner.iconUrl;
      const currentUserTemplate = matches.find((template: any) => String(template.createdBy || '') === String(userId));
      if (currentUserTemplate) return currentUserTemplate.iconUrl;
      const publicTemplate = matches.find((template: any) => template.visibility === 'public');
      return (publicTemplate || matches[0]).iconUrl || '';
    };

    const profiles = await AgentProfile.find({
      podId,
      agentName: { $in: installations.map((i: any) => i.agentName) },
    }).lean();

    // Batch-fetch the bot User rows so the payload builder can resolve
    // displayName via the curated `botMetadata.displayName` rather than
    // the (possibly stale) `installation.displayName`. ADR-001 §3.10:
    // identity is separate from package — the User row is the source of
    // truth for identity labels. Map by (agentName, instanceId).
    const User = require('../../models/User');
    const usernameSet = new Set<string>();
    for (const i of installations as any[]) {
      const username = AgentIdentityService.buildAgentUsername(i.agentName, i.instanceId || 'default');
      if (username) usernameSet.add(username);
    }
    const userRows = usernameSet.size > 0
      ? await User.find({ username: { $in: Array.from(usernameSet) } })
        .select('username botMetadata agentRuntimeTokens.lastUsedAt')
        .lean()
      : [];
    const userByUsername = new Map<string, any>(
      (userRows as any[]).map((u: any) => [u.username, u]),
    );

    res.json({
      agents: installations.map((i: any) => {
        const profile = profiles.find(
          (p: any) => p.agentName === i.agentName && p.instanceId === (i.instanceId || 'default'),
        );
        const templateIcon = getTemplateIcon(i);
        const instanceKey = `${i.agentName}:${i.instanceId || 'default'}`;
        const username = AgentIdentityService.buildAgentUsername(i.agentName, i.instanceId || 'default');
        const user = userByUsername.get(username) || null;
        // Max across the three proof-of-life sources; each covers a runtime
        // class the others miss (heartbeats: gateway; token use: BYO/MCP;
        // runs: native).
        const tokenTimes = (user?.agentRuntimeTokens || [])
          .map((tok: any) => (tok?.lastUsedAt ? new Date(tok.lastUsedAt).getTime() : 0));
        const candidates = [
          heartbeatMap.get(instanceKey), runMap.get(instanceKey), ...tokenTimes,
        ]
          .map((v: any) => (v ? new Date(v).getTime() : 0))
          .filter((v: number) => Number.isFinite(v) && v > 0);
        const lastActiveAt = candidates.length > 0 ? new Date(Math.max(...candidates)) : null;
        return buildAgentInstallationPayload(i, {
          profile,
          iconUrl: templateIcon || iconMap.get(i.agentName) || '',
          lastHeartbeatAt: heartbeatMap.get(instanceKey) || null,
          lastActiveAt,
          user,
        });
      }),
    });
  } catch (error) {
    console.error('Error listing pod agents:', error);
    res.status(500).json({ error: 'Failed to list pod agents' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name?instanceId=
 * Return a single installed agent payload with latest persisted config/profile.
 */
podAgentsRouter.get('/pods/:podId/agents/:name', auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { installation } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: req.query.instanceId,
    });
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }
    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });
    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!installation || installation.status === 'uninstalled') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const [registryEntry, profile, templateCandidates] = await Promise.all([
      AgentRegistry.findOne({ agentName: installation.agentName }).select('iconUrl').lean(),
      AgentProfile.findOne({
        podId,
        agentName: installation.agentName,
        instanceId: installation.instanceId || 'default',
      }).lean(),
      AgentTemplate.find({
        agentName: installation.agentName,
        displayName: installation.displayName,
        $or: [
          { visibility: 'public' },
          { createdBy: userId },
          { createdBy: installation.installedBy },
        ],
      }).select('iconUrl createdBy visibility').lean(),
    ]);
    const installedBy = installation.installedBy?.toString?.() || String(installation.installedBy || '');
    const templateIcon = (
      templateCandidates.find((template: any) => String(template.createdBy || '') === installedBy)
      || templateCandidates.find((template: any) => String(template.createdBy || '') === String(userId))
      || templateCandidates.find((template: any) => template.visibility === 'public')
      || templateCandidates[0]
    )?.iconUrl || '';

    return res.json({
      agent: buildAgentInstallationPayload(installation, {
        profile,
        iconUrl: templateIcon || registryEntry?.iconUrl || '',
      }),
    });
  } catch (error) {
    console.error('Error loading installed pod agent:', error);
    return res.status(500).json({ error: 'Failed to load installed agent' });
  }
});

module.exports = podAgentsRouter;

export {};
