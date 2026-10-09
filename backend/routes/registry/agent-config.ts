// Agent configuration update route — extracted from registry.js (GH#112)
// Handles: PATCH /pods/:podId/agents/:name
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const Pod = require('../../models/Pod');
const {
  writeWorkspaceIdentityFile,
  syncOpenClawSkills,
} = require('../../services/agentProvisionerService');
const {
  getUserId,
  isGlobalAdminUser,
  normalizeInstanceId,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
  buildIdentityContent,
  userHasPodAccess,
  buildAgentProfileId,
} = require('./helpers');
const {
  normalizeToolPolicy,
  normalizeContextPolicy,
} = require('./tokens');
const { validateEnvironmentMcpEntries } = require('../../utils/environmentSpecValidation');

const agentConfigRouter = express.Router();

/**
 * Every field this handler writes, and so every field the installer gate below
 * covers. The gate is deliberately the whole PATCH, not just `config`: the same
 * membership-gated handler writes the AgentProfile (`displayName`, `status`,
 * `instructions`, `persona`, `toolPolicy`, `contextPolicy`, `modelPreferences`)
 * and drives `config.skillSync`. A narrower gate leaves those open.
 */
const INSTALLER_GATED_FIELDS = [
  'config',
  'scopes',
  'status',
  'displayName',
  'modelPreferences',
  'instructions',
  'persona',
  'toolPolicy',
  'contextPolicy',
];

/**
 * PATCH /api/registry/pods/:podId/agents/:name
 * Update agent configuration in a pod
 */
agentConfigRouter.patch('/pods/:podId/agents/:name', auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const {
      config,
      scopes,
      status,
      modelPreferences,
      instanceId,
      displayName,
      instructions,
      persona,
      toolPolicy,
      contextPolicy,
    } = req.body;
    const normalizedToolPolicy = normalizeToolPolicy(toolPolicy);
    const normalizedContextPolicy = normalizeContextPolicy(contextPolicy);
    const normalizedInstanceId = normalizeInstanceId(instanceId);
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

    const installation = await AgentInstallation.findOne({
      agentName: name.toLowerCase(),
      podId,
      instanceId: normalizedInstanceId,
    });

    if (!installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    // Pod membership is a precondition, not an authority. Changing an installed
    // agent is the installer's or an instance admin's call, because `config`
    // reaches the owner's machine: agentBinding projects `config.environment`
    // to the owner's daemon as the seat's declared spec, so a member who can
    // write it can make that daemon run a declared stdio command and mail the
    // seat's runtime token to a host of their choosing. Measured on 23e00668
    // (Vera 69500): a non-owner member PATCHed `config.environment` and got 200.
    const isInstaller = installation.installedBy?.toString?.() === userId.toString();
    // `req.user.role` is only populated on the API-token auth path, so fall
    // back to the stored user. Computed even when the caller IS the installer:
    // the scope below is decided by the ROLE, not by which row they happen to
    // have installed, and deriving it only on the non-installer path would
    // scope the same admin's PATCH differently depending on how they
    // authenticated.
    const isInstanceAdmin = req.user?.role === 'admin'
      || await isGlobalAdminUser(userId);
    if (!isInstaller && !isInstanceAdmin) {
      return res.status(403).json({
        error: 'Only the agent installer or an instance admin can change an installed agent',
        code: 'installer_only',
        fields: INSTALLER_GATED_FIELDS.filter((field) => field in req.body),
      });
    }

    // WRITE-TIME SHAPE CHECK (TASK-071, Vera's ruling). This route is one of
    // TWO backend writers of `config.environment` (the other is
    // POST /api/registry/install, which checks the same thing), and that field
    // is projected to the owner's daemon as the seat's declared spec — so an
    // entry whose fields contradict its own transport is a stored instruction
    // whose every reader answers differently. Refused here, before any write, rather than
    // reconciled on the read path: a record that says two things is not a
    // record a reader should have to arbitrate.
    //
    // Deliberately only what THIS BODY declares. The merged result is not
    // checked, so a row that already holds a malformed entry stays patchable
    // for its other fields — refusing old records is not this rule's job.
    if (config && typeof config === 'object' && config.environment !== undefined) {
      const environmentErrors = validateEnvironmentMcpEntries(config.environment);
      if (environmentErrors.length) {
        return res.status(400).json({
          error: 'Invalid environment spec',
          code: 'invalid_environment_spec',
          fields: environmentErrors,
        });
      }
    }

    const applyInstallationSettings = (targetInstallation: any) => {
      if (!targetInstallation) return;
      if (config) {
        const existingConfig = normalizeConfigMap(targetInstallation.config) || {};
        const nextConfig = { ...existingConfig, ...config };
        if (nextConfig.runtime && typeof nextConfig.runtime === 'object') {
          const runtimeConfig = { ...nextConfig.runtime };
          const normalizedAuthProfiles = normalizeRuntimeAuthProfiles(runtimeConfig.authProfiles);
          if (normalizedAuthProfiles) {
            runtimeConfig.authProfiles = normalizedAuthProfiles;
          } else if (runtimeConfig.authProfiles === null) {
            delete runtimeConfig.authProfiles;
          }
          const normalizedSkillEnv = normalizeSkillEnvEntries(runtimeConfig.skillEnv);
          if (normalizedSkillEnv) {
            runtimeConfig.skillEnv = normalizedSkillEnv;
          } else if (runtimeConfig.skillEnv === null) {
            delete runtimeConfig.skillEnv;
          }
          nextConfig.runtime = runtimeConfig;
        }
        targetInstallation.config = new Map(Object.entries(nextConfig));
      }
      if (scopes) {
        targetInstallation.scopes = scopes;
      }
      if (status && ['active', 'paused'].includes(status)) {
        targetInstallation.status = status;
      }
      if (displayName) {
        targetInstallation.displayName = displayName;
      }
    };

    const peerInstallations = await AgentInstallation.find({
      agentName: name.toLowerCase(),
      instanceId: normalizedInstanceId,
      status: { $ne: 'uninstalled' },
    });

    const peerByPod = new Map(
      peerInstallations.map((entry: any) => [entry.podId?.toString?.() || '', entry]),
    );
    if (!peerByPod.has(podId.toString())) {
      peerByPod.set(podId.toString(), installation);
    }

    let accessiblePodIds = [podId.toString()];
    if (peerByPod.size > 1) {
      const peerPodIds = Array.from(peerByPod.keys()).filter(Boolean);
      const peerPods = await Pod.find({ _id: { $in: peerPodIds } })
        .select('_id members createdBy')
        .lean();
      accessiblePodIds = peerPods
        .filter((entry: any) => userHasPodAccess(entry, userId))
        .map((entry: any) => entry._id.toString());
      if (!accessiblePodIds.includes(podId.toString())) {
        accessiblePodIds.push(podId.toString());
      }
    }

    const accessiblePodSet = new Set(accessiblePodIds);
    const accessibleInstallations: any[] = Array.from(peerByPod.entries())
      .filter(([entryPodId]: any[]) => accessiblePodSet.has(entryPodId))
      .map(([, entry]: any[]) => entry);

    // The fan-out reaches this agent's installations in OTHER pods, and those
    // rows have their own installers. Installing the seat here is not authority
    // over someone else's row there, so an installer who is not an admin only
    // writes the rows they installed — while an INSTANCE ADMIN keeps the
    // instance-wide reach whether or not they are also this row's installer:
    // authority is a role, not a coincidence of which row they created
    // (Wren 69565).
    const ownsInstallation = (entry: any) => entry?.installedBy?.toString?.() === userId.toString();
    const installationsToUpdate: any[] = isInstanceAdmin
      ? accessibleInstallations
      : accessibleInstallations.filter(ownsInstallation);
    const writablePodIds = Array.from(new Set(
      installationsToUpdate
        .map((entry: any) => entry.podId?.toString?.() || '')
        .filter(Boolean),
    ));

    for (const targetInstallation of installationsToUpdate) {
      applyInstallationSettings(targetInstallation);
      // eslint-disable-next-line no-await-in-loop
      await targetInstallation.save();
    }

    if (
      status
      || modelPreferences
      || displayName
      || instructions !== undefined
      || persona !== undefined
      || normalizedToolPolicy !== null
      || normalizedContextPolicy !== null
    ) {
      const updates: any = {};
      if (status) updates.status = status;
      if (modelPreferences) updates.modelPreferences = modelPreferences;
      if (displayName) updates.name = displayName;
      if (instructions !== undefined) updates.instructions = instructions;
      if (persona !== undefined) updates.persona = persona;
      if (normalizedToolPolicy !== null) updates.toolPolicy = normalizedToolPolicy;
      if (normalizedContextPolicy !== null) updates.contextPolicy = normalizedContextPolicy;
      await AgentProfile.updateMany(
        {
          agentId: buildAgentProfileId(name, normalizedInstanceId),
          podId: { $in: writablePodIds },
        },
        updates,
      );

      if ((persona !== undefined || displayName) && normalizedInstanceId && name.toLowerCase() === 'openclaw') {
        const identityContent = buildIdentityContent(displayName || normalizedInstanceId, persona || {});
        writeWorkspaceIdentityFile(normalizedInstanceId, identityContent).catch((err: any) => {
          console.warn('[registry] Failed to sync IDENTITY.md for', normalizedInstanceId, err.message);
        });
      }
    }

    const skillSync = config?.skillSync || null;
    if (skillSync && name.toLowerCase() === 'openclaw') {
      const mode = skillSync.mode === 'selected' ? 'selected' : 'all';
      const requestedPodIds = Array.isArray(skillSync.podIds)
        ? skillSync.podIds.map((id: any) => String(id)).filter(Boolean)
        : [];
      let podIdsToSync = requestedPodIds;
      if (skillSync.allPods) {
        const installations = await AgentInstallation.find({
          agentName: name.toLowerCase(),
          instanceId: normalizedInstanceId,
          status: 'active',
        }).lean();
        podIdsToSync = installations.map((i: any) => i.podId?.toString?.()).filter(Boolean);
      }
      if (podIdsToSync.length) {
        const pods = await Pod.find({ _id: { $in: podIdsToSync } })
          .select('members createdBy')
          .lean();
        podIdsToSync = pods
          .filter((p: any) => userHasPodAccess(p, userId))
          .map((p: any) => p._id.toString());
      }
      await syncOpenClawSkills({
        accountId: normalizedInstanceId,
        podIds: podIdsToSync,
        mode,
        skillNames: Array.isArray(skillSync.skillNames) ? skillSync.skillNames : [],
      });
    }

    res.json({
      success: true,
      installation: {
        name: installation.agentName,
        version: installation.version,
        status: installation.status,
        scopes: installation.scopes,
      },
      updatedPods: installationsToUpdate.length,
    });
  } catch (error) {
    console.error('Error updating agent:', error);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

module.exports = agentConfigRouter;

export {};
