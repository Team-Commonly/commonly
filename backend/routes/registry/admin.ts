// Admin-only registry routes — extracted from registry.js (GH#112)
export {};
const express = require('express');
const auth = require('../../middleware/auth');
const adminAuth = require('../../middleware/adminAuth');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentIdentityService = require('../../services/agentIdentityService');
const AgentEventService = require('../../services/agentEventService');
const { restartAgentRuntime } = require('../../services/agentProvisionerService');
const { hash, randomSecret } = require('../../utils/secret');
const {
  escapeRegExp,
  getUserId,
  serializeRuntimeTokens,
  normalizeConfigMap,
  sanitizeRuntimeConfig,
  buildAgentProfileId,
} = require('./helpers');
const { reprovisionInstallation } = require('./reprovision');

const adminRouter = express.Router();

/**
 * GET /api/registry/admin/installations
 * List all agent installations (admin only)
 */
adminRouter.get('/admin/installations', auth, adminAuth, async (req: any, res: any) => {
  try {
    const {
      q,
      status = 'active',
      limit: limitParam,
      offset: offsetParam,
    } = req.query || {};

    const limit = Math.min(Math.max(parseInt(limitParam, 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(offsetParam, 10) || 0, 0);

    const filter: any = {};
    if (status && status !== 'all') {
      filter.status = status;
    }

    if (q) {
      const regex = new RegExp(escapeRegExp(String(q).trim()), 'i');
      const matchedPods = await Pod.find({ name: regex }).select('_id').lean();
      const matchedPodIds = (matchedPods as any[]).map((pod: any) => pod._id);
      filter.$or = [
        { agentName: regex },
        { displayName: regex },
        { instanceId: regex },
        ...(matchedPodIds.length ? [{ podId: { $in: matchedPodIds } }] : []),
      ];
    }

    const [total, installations] = await Promise.all([
      AgentInstallation.countDocuments(filter),
      AgentInstallation.find(filter)
        .sort({ updatedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
    ]);

    const podIds = (installations as any[]).map((install: any) => install.podId).filter(Boolean);
    const pods = await Pod.find({ _id: { $in: podIds } })
      .select('_id name createdBy')
      .lean();
    const podMap = new Map((pods as any[]).map((pod: any) => [pod._id.toString(), pod]));

    const userIds = new Set();
    (installations as any[]).forEach((install: any) => {
      if (install.installedBy) userIds.add(install.installedBy.toString());
    });
    (pods as any[]).forEach((pod: any) => {
      if (pod.createdBy) userIds.add(pod.createdBy.toString());
    });

    const users = userIds.size
      ? await User.find({ _id: { $in: Array.from(userIds) } })
        .select('_id username email role')
        .lean()
      : [];
    const userMap = new Map((users as any[]).map((user: any) => [user._id.toString(), user]));

    const payload = (installations as any[]).map((install: any) => {
      const pod: any = podMap.get(install.podId?.toString?.() || '');
      const installedBy: any = install.installedBy
        ? userMap.get(install.installedBy.toString())
        : null;
      const podOwner: any = pod?.createdBy
        ? userMap.get(pod.createdBy.toString())
        : null;

      return {
        id: install._id?.toString(),
        agentName: install.agentName,
        instanceId: install.instanceId,
        displayName: install.displayName,
        version: install.version,
        status: install.status,
        scopes: install.scopes || [],
        pod: pod
          ? {
            id: pod._id?.toString(),
            name: pod.name,
            createdBy: podOwner
              ? {
                id: podOwner._id?.toString(),
                username: podOwner.username,
                email: podOwner.email,
                role: podOwner.role,
              }
              : null,
          }
          : null,
        installedBy: installedBy
          ? {
            id: installedBy._id?.toString(),
            username: installedBy.username,
            email: installedBy.email,
            role: installedBy.role,
          }
          : null,
        runtimeTokens: serializeRuntimeTokens(install.runtimeTokens || []),
        usage: install.usage || {},
        createdAt: install.createdAt,
        updatedAt: install.updatedAt,
        config: (() => {
          const normalizedConfig = normalizeConfigMap(install.config) || {};
          if (normalizedConfig.runtime) {
            normalizedConfig.runtime = sanitizeRuntimeConfig(normalizedConfig.runtime);
          }
          return normalizedConfig;
        })(),
      };
    });

    return res.json({
      total,
      installations: payload,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error listing admin installations:', error);
    return res.status(500).json({ error: 'Failed to list installations' });
  }
});

/**
 * POST /api/registry/admin/installations/reprovision-all
 * Force reprovision all active agent installations (global admin only).
 */
adminRouter.post('/admin/installations/reprovision-all', auth, adminAuth, async (req: any, res: any) => {
  try {
    const limitRaw = Number(req.body?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), 5000)
      : 1000;
    const activeInstallations = await AgentInstallation.find({ status: 'active' })
      .sort({ updatedAt: -1 })
      .limit(limit);

    const runtimeTokenCache = new Map();
    const userTokenCache = new Map();
    const items = [];
    const sharedRuntimesNeedingRestart = new Set();
    for (const installation of activeInstallations) {
      try {
        const result = await reprovisionInstallation({
          installation,
          force: true,
          runtimeTokenCache,
          userTokenCache,
          skipRuntimeRestart: true,
        });
        // Track which shared runtimes need a single deferred restart
        if (result.runtimeType === 'moltbot') sharedRuntimesNeedingRestart.add('moltbot');
        items.push({
          installationId: result.installationId,
          agentName: result.agentName,
          instanceId: result.instanceId,
          podId: result.podId,
          success: true,
          runtimeStarted: result.runtimeStarted,
          runtimeRestarted: false,
          runtimeStartError: result.runtimeStartError,
          runtimeRestartError: null,
        });
      } catch (error: unknown) {
        items.push({
          installationId: installation._id?.toString(),
          agentName: installation.agentName,
          instanceId: installation.instanceId || 'default',
          podId: installation.podId?.toString?.() || null,
          success: false,
          error: (error as Error).message,
        });
      }
    }

    // Single gateway restart after all agents provisioned (instead of one per agent)
    if (sharedRuntimesNeedingRestart.has('moltbot')) {
      await restartAgentRuntime('moltbot', 'default', {}).catch((err: any) => {
        console.warn('[reprovision-all] Failed to restart gateway:', err.message);
      });
    }

    const succeeded = items.filter((item) => item.success).length;
    const failed = items.length - succeeded;
    return res.json({
      success: failed === 0,
      attempted: items.length,
      succeeded,
      failed,
      items,
    });
  } catch (error) {
    console.error('Error running bulk reprovision:', error);
    return res.status(500).json({ error: 'Failed to run bulk reprovision' });
  }
});

/**
 * DELETE /api/registry/admin/installations/:installationId/runtime-tokens/:tokenId
 * Revoke a runtime token for an installation (admin only)
 */
adminRouter.delete('/admin/installations/:installationId/runtime-tokens/:tokenId', auth, adminAuth, async (req: any, res: any) => {
  try {
    const { installationId, tokenId } = req.params;
    const installation = await AgentInstallation.findById(installationId);
    if (!installation) {
      return res.status(404).json({ error: 'Installation not found' });
    }

    const originalCount = installation.runtimeTokens?.length || 0;
    installation.runtimeTokens = (installation.runtimeTokens || []).filter(
      (token: any) => token._id?.toString() !== tokenId,
    );

    if ((installation.runtimeTokens || []).length === originalCount) {
      return res.status(404).json({ error: 'Runtime token not found' });
    }

    await installation.save();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error revoking admin runtime token:', error);
    return res.status(500).json({ error: 'Failed to revoke runtime token' });
  }
});

/**
 * DELETE /api/registry/admin/installations/:installationId
 * Uninstall an agent instance from a pod (admin only)
 */
adminRouter.delete('/admin/installations/:installationId', auth, adminAuth, async (req: any, res: any) => {
  try {
    const { installationId } = req.params;
    const installation = await AgentInstallation.findById(installationId);
    if (!installation) {
      return res.status(404).json({ error: 'Installation not found' });
    }

    if (installation.status === 'uninstalled') {
      return res.json({ success: true, alreadyUninstalled: true });
    }

    installation.status = 'uninstalled';
    await installation.save();

    const podId = installation.podId;
    const agentName = installation.agentName;
    const instanceId = installation.instanceId;

    await AgentProfile.deleteOne({ agentId: buildAgentProfileId(agentName, instanceId), podId });

    try {
      const resolvedType = AgentIdentityService.resolveAgentType(agentName);
      await AgentIdentityService.removeAgentFromPod(
        AgentIdentityService.buildAgentUsername(resolvedType, instanceId),
        podId,
      );
    } catch (identityError: unknown) {
      console.warn('Failed to remove agent user from pod:', (identityError as Error).message);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error uninstalling admin installation:', error);
    return res.status(500).json({ error: 'Failed to uninstall installation' });
  }
});

/**
 * POST /api/registry/admin/agents/claude-code/session-token
 * Issue a session-scoped runtime token for a Claude Code agent (e.g. a Happy session).
 */
adminRouter.post('/admin/agents/claude-code/session-token', auth, adminAuth, async (req: any, res: any) => {
  try {
    const { podId, instanceId: requestedInstanceId, displayName, expiresIn } = req.body;

    if (!podId) {
      return res.status(400).json({ error: 'podId is required' });
    }

    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const instanceId = requestedInstanceId || `sess-${randomSecret(8)}`;

    // Default to Commonly's existing `<Primary> (Context)` parenthetical naming
    // pattern — see live DB examples like 'Backend Engineer (Nova)', 'Dev PM (Theo)'.
    // Derive a readable primary label from the instanceId (stripping the 'sess-'
    // prefix when it's an auto-generated session id), postfix with the runtime.
    // If the caller already passed a displayName containing '(Claude Code)', use
    // it as-is so explicit names don't get doubled.
    const primaryLabel = (() => {
      if (displayName && !displayName.includes('(Claude Code)')) return displayName;
      if (instanceId.startsWith('sess-')) return instanceId.slice(5, 13); // 8 readable hex chars
      return instanceId;
    })();
    const finalDisplayName = displayName?.includes('(Claude Code)')
      ? displayName
      : `${primaryLabel} (Claude Code)`;

    const agentUser = await AgentIdentityService.getOrCreateAgentUser('claude-code', {
      instanceId,
      displayName: finalDisplayName,
    });

    // Ensure pod membership — plain ObjectId array per Pod.members invariant.
    // ADR-001 §3.10: DM pods are strictly 1:1, so an admin attaching a
    // claude-code session into an existing DM is rejected. The admin should
    // either pick a non-DM pod or spawn a fresh agent-dm/agent-room with the
    // claude-code agent as one of the two members.
    const isMember = pod.members?.some((m: any) => m.toString() === agentUser._id.toString());
    if (!isMember) {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const { DM_POD_TYPES_GUARD } = require('../../services/agentIdentityService');
      if (DM_POD_TYPES_GUARD.has(String(pod.type))) {
        return res.status(403).json({
          error: 'DM pods are 1:1 — cannot attach a third agent. Use a chat pod or create a new DM.',
        });
      }
      pod.members.push(agentUser._id);
      await pod.save();
    }

    // Upsert AgentInstallation so agentRuntimeAuth authorizes this pod for the token
    await AgentInstallation.findOneAndUpdate(
      { agentName: 'claude-code', podId, instanceId },
      {
        $setOnInsert: {
          agentName: 'claude-code',
          podId,
          instanceId,
          displayName: finalDisplayName,
          version: '1.0.0',
          installedBy: req.user._id,
          scopes: ['context:read', 'messages:write', 'memory:read'],
          config: { runtime: { runtimeType: 'claude-code' } },
        },
        $set: { status: 'active' },
      },
      { upsert: true, new: true },
    );

    // Always issue a fresh token for this session (never reuse — each session is independent)
    const expiresInSeconds = Number(expiresIn) || 86400; // default 24h
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const rawToken = `cm_agent_${randomSecret(32)}`;

    agentUser.agentRuntimeTokens = agentUser.agentRuntimeTokens || [];
    agentUser.agentRuntimeTokens.push({
      tokenHash: hash(rawToken),
      label: `Session: ${instanceId}`,
      createdAt: new Date(),
      expiresAt,
    });
    await agentUser.save();

    console.log(`Issued claude-code session token: instanceId=${instanceId} pod=${pod.name} expires=${expiresAt.toISOString()}`);

    return res.json({
      token: rawToken,
      agentName: 'claude-code',
      instanceId,
      podId: pod._id,
      podName: pod.name,
      expiresAt,
    });
  } catch (error) {
    console.error('Error issuing claude-code session token:', error);
    return res.status(500).json({ error: 'Failed to issue session token' });
  }
});

/**
 * POST /api/registry/admin/agents/:agentName/trigger-heartbeat
 * Immediately fire a heartbeat for a named agent (admin only).
 */
adminRouter.post('/admin/agents/:agentName/trigger-heartbeat', auth, adminAuth, async (req: any, res: any) => {
  try {
    const { agentName } = req.params;
    const { instanceId = 'default' } = req.body || {};

    if (!agentName) {
      return res.status(400).json({ error: 'agentName is required' });
    }

    const installations = await AgentInstallation.find({
      agentName: agentName.toLowerCase(),
      instanceId,
      status: 'active',
    }).select('agentName instanceId podId config.heartbeat').lean();

    if (!installations.length) {
      return res.status(404).json({
        error: `No active installation found for agent '${agentName}' instanceId '${instanceId}'`,
      });
    }

    const installation = installations[0];
    await AgentEventService.enqueue({
      agentName: installation.agentName,
      instanceId: installation.instanceId,
      podId: installation.podId,
      type: 'heartbeat',
      payload: { trigger: 'admin-manual' },
    });

    return res.json({
      enqueued: 1,
      agentName: installation.agentName,
      instanceId: installation.instanceId,
      podId: installation.podId?.toString(),
    });
  } catch (error) {
    console.error('Error triggering manual heartbeat:', error);
    return res.status(500).json({ error: 'Failed to trigger heartbeat' });
  }
});

module.exports = adminRouter;
