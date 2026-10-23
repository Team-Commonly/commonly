// Agent configuration update route — extracted from registry.js (GH#112)
// Handles: PATCH /pods/:podId/agents/:name
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentInstallation } = require('../../models/AgentRegistry');
const User = require('../../models/User');
const AgentIdentityService = require('../../services/agentIdentityService');
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
  revokeRuntimeTokensForAgent,
} = require('./tokens');
const { validateEnvironmentMcpEntries } = require('../../utils/environmentSpecValidation');
const { ownsRuntimeIdentity, webhookUrlRefusal } = require('../../services/runtimeIdentityOwnership');
const { configWriteRefusal, runtimeKeepingType } = require('../../services/configWriteGuard');
const { assertAgentRuntimeMayJoinPod } = require('../../services/outsiderGrantAgentJoinPolicy');
const { hostedEngineInEffect } = require('../../services/hostedEngine');
const {
  isPrivateListenerEnvironment, privateListenerConfigurationValid,
  privateListenerPodAllowed, privateListenerIdentityAllowed,
} = require('../../services/privateListenerPolicy');

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

    const isInstanceAdmin = req.user?.role === 'admin' || await isGlobalAdminUser(userId);
    if (!membership && !isCreator && !isInstanceAdmin) {
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

    // For a non-admin, pod membership is a precondition, not an authority. Changing an installed
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
    if (!isInstaller && !isInstanceAdmin) {
      return res.status(403).json({
        error: 'Only the agent installer or an instance admin can change an installed agent',
        code: 'installer_only',
        fields: INSTALLER_GATED_FIELDS.filter((field) => field in req.body),
      });
    }

    if (displayName !== undefined && (typeof displayName !== 'string'
      || !displayName.trim() || displayName.trim().length > 80)) {
      return res.status(400).json({ error: 'Display name must be 1–80 characters' });
    }
    if (normalizedContextPolicy) {
      const numbers = ['maxTokens', 'compactionThreshold', 'summaryHours'];
      if (numbers.some((key) => normalizedContextPolicy[key] !== undefined
        && (!Number.isInteger(normalizedContextPolicy[key]) || normalizedContextPolicy[key] < 1))
        || (normalizedContextPolicy.maxTokens !== undefined
          && normalizedContextPolicy.compactionThreshold !== undefined
          && normalizedContextPolicy.compactionThreshold > normalizedContextPolicy.maxTokens)
        || ['includeMemory', 'includeSkills', 'includeSummaries'].some((key) => (
          normalizedContextPolicy[key] !== undefined && typeof normalizedContextPolicy[key] !== 'boolean'
        ))) {
        return res.status(400).json({ error: 'Invalid context policy' });
      }
    }
    const requestedSandboxMode = config?.environment?.sandbox?.mode;
    if (requestedSandboxMode !== undefined && !['none', 'workspace', 'read-only', 'bwrap',
      'firejail', 'container', 'managed'].includes(requestedSandboxMode)) {
      return res.status(400).json({ error: 'Invalid sandbox mode' });
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
      if (isPrivateListenerEnvironment(config.environment)) {
        const existingConfig = normalizeConfigMap(installation.config) || {};
        const runtimeType = config.runtime?.runtimeType || existingConfig.runtime?.runtimeType;
        const eligible = privateListenerConfigurationValid(config.environment)
          && await privateListenerPodAllowed(podId, userId)
          && await privateListenerIdentityAllowed(name.toLowerCase(), normalizedInstanceId, userId, true);
        if (!eligible || !['wrapper', 'webhook'].includes(runtimeType)) {
          return res.status(403).json({
            code: 'private_listener_not_allowed',
            error: 'Full computer access requires your sole-human invite-only pod and an absolute repo path',
          });
        }
      }
    }

    // Being this row's installer is not enough to point its push webhook
    // somewhere new. The webhook's replies are posted as the agent identity, so
    // setting or changing `config.runtime.webhookUrl` takes the sole-installer
    // rule the runtime-token routes apply (services/runtimeIdentityOwnership),
    // admins exempt. Clearing it, or resending the stored value, does not.
    const requestedWebhookUrl = config?.runtime?.webhookUrl;
    const storedWebhookUrl = normalizeConfigMap(installation.config)?.runtime?.webhookUrl;
    if (requestedWebhookUrl && requestedWebhookUrl !== storedWebhookUrl && !isInstanceAdmin) {
      const ownership = await ownsRuntimeIdentity(userId, name.toLowerCase(), normalizedInstanceId);
      if (!ownership.owned) {
        return res.status(403).json({ code: ownership.failure, error: webhookUrlRefusal[ownership.failure] });
      }
    }

    const applyInstallationSettings = (targetInstallation: any) => {
      if (!targetInstallation) return;
      if (config) {
        const existingConfig = normalizeConfigMap(targetInstallation.config) || {};
        const nextConfig = { ...existingConfig, ...config };
        // The Settings model editor receives only these safe fields, never
        // the full ADR-008 declaration. Preserve MCP, workspace and sandbox
        // values when it changes a model/effort/adapter control.
        const environmentControls = config.environment;
        if (environmentControls && typeof environmentControls === 'object'
          && !Array.isArray(environmentControls)
          && Object.keys(environmentControls).every((key) => ['model', 'effort', 'adapter', 'sandbox'].includes(key))
          && (!environmentControls.sandbox || (typeof environmentControls.sandbox === 'object'
            && !Array.isArray(environmentControls.sandbox)
            && Object.keys(environmentControls.sandbox).every((key) => key === 'mode')))) {
          nextConfig.environment = { ...(existingConfig.environment || {}), ...environmentControls,
            ...(environmentControls.sandbox ? { sandbox: {
              ...(existingConfig.environment?.sandbox || {}), ...environmentControls.sandbox,
            } } : {}) };
        }
        if (config.runtime && typeof config.runtime === 'object') {
          nextConfig.runtime = runtimeKeepingType(config.runtime, existingConfig, { mayChangeType: isInstanceAdmin });
        }
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
    // A display name belongs to the portable User principal. Check every
    // installed projection, including paused ones: runtime-token ownership
    // intentionally looks only at active rows and would reject a paused seat
    // even when this caller is its sole installer.
    if (displayName !== undefined && !isInstanceAdmin) {
      const missingInstaller = peerInstallations.some((entry: any) => !entry.installedBy);
      const anotherInstaller = peerInstallations.some(
        (entry: any) => entry.installedBy && entry.installedBy.toString() !== userId.toString(),
      );
      if (missingInstaller || anotherInstaller) {
        return res.status(403).json({
          code: missingInstaller ? 'unknown_installer' : 'another_installer',
          error: 'Only the sole installer or an instance admin can rename this agent identity',
        });
      }
    }

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
        .filter((entry: any) => isInstanceAdmin || userHasPodAccess(entry, userId))
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
    // A rename changes the portable User label seen in every pod. Refuse it
    // unless the same request will update every non-uninstalled projection.
    if (displayName !== undefined && installationsToUpdate.length !== peerByPod.size) {
      return res.status(409).json({
        code: 'identity_rename_scope_incomplete',
        error: 'This identity has installations outside your writable pods',
      });
    }
    const writablePodIds = Array.from(new Set(
      installationsToUpdate
        .map((entry: any) => entry.podId?.toString?.() || '')
        .filter(Boolean),
    ));

    // The runtime type, what Commonly's compute does for an agent it runs, and
    // the kernel's own records are not this route's to change
    // (services/configWriteGuard.ts). Checked against every row the write
    // would reach, before any of them is saved.
    const writeRefusal = configWriteRefusal({
      requested: config,
      targets: installationsToUpdate.map((entry: any) => entry.config),
      isInstanceAdmin,
    });
    if (writeRefusal) {
      const { status: refusalStatus, ...refusalBody } = writeRefusal;
      return res.status(refusalStatus).json(refusalBody);
    }
    // An installation can show a different label from its bot User. Guard
    // every affected installer's active cards, including when an admin edits
    // someone else's agent, before renaming the shared identity.
    if (displayName !== undefined) {
      const requestedName = displayName.trim().toLowerCase();
      const installerIds = Array.from(new Set(installationsToUpdate
        .map((entry: any) => entry.installedBy?.toString?.())
        .filter(Boolean)));
      const ownerInstallations = await AgentInstallation.find({
        installedBy: { $in: installerIds }, status: 'active',
      });
      const nameTaken = ownerInstallations.some((entry: any) => (
        !(entry.agentName === name.toLowerCase()
          && (entry.instanceId || 'default') === normalizedInstanceId)
        && String(entry.displayName || entry.agentName || '').trim().toLowerCase() === requestedName
      ));
      if (nameTaken) {
        return res.status(409).json({
          code: 'agent_display_name_taken',
          error: 'Another agent already uses this name',
        });
      }
    }
    // Decide for every fan-out target before saving any row. A runtime object
    // without runtimeType also removes an existing native declaration here.
    if (config?.runtime !== undefined || status === 'active') {
      try {
        for (const targetInstallation of installationsToUpdate) {
          const stored = normalizeConfigMap(targetInstallation.config) || {};
          const runtime = config?.runtime !== undefined ? config.runtime : stored.runtime;
          // eslint-disable-next-line no-await-in-loop
          await assertAgentRuntimeMayJoinPod(
            targetInstallation.podId, runtime?.runtimeType,
            hostedEngineInEffect({ config: stored }),
          );
        }
      } catch (joinError: any) {
        if (joinError?.code === 'outsider_grant_non_native_agent_join') {
          return res.status(403).json({ code: joinError.code, message: joinError.message });
        }
        throw joinError;
      }
    }

    const downgradesPrivateListener = config?.environment !== undefined
      && !isPrivateListenerEnvironment(config.environment)
      && installationsToUpdate.some((entry: any) => isPrivateListenerEnvironment(
        normalizeConfigMap(entry.config)?.environment,
      ));
    if (downgradesPrivateListener) {
      // A running one-command listener cached its private environment at boot.
      // Revoking before the new public config is visible makes its saved bearer
      // unusable; the owner must reconnect against the public projection.
      const resolvedType = AgentIdentityService.resolveAgentType(name.toLowerCase());
      const username = AgentIdentityService.buildAgentUsername(resolvedType, normalizedInstanceId);
      const agentUser = await User.findOne({ username, isBot: true });
      await revokeRuntimeTokensForAgent({
        agentUser, agentName: name.toLowerCase(), instanceId: normalizedInstanceId,
      });
    }

    // The User row is the name source for chat and the pod roster. An explicit
    // rename must update that portable identity, not only per-pod projections.
    let renamedIdentity;
    try {
      renamedIdentity = displayName === undefined ? undefined
        : await AgentIdentityService.renameAgentDisplayName(name, normalizedInstanceId, displayName.trim());
    } catch (renameError: any) {
      if (renameError?.code === 'agent_display_name_taken') {
        return res.status(409).json({ code: renameError.code, error: renameError.message });
      }
      throw renameError;
    }
    if (renamedIdentity === null) {
      return res.status(404).json({ error: 'Agent identity not found' });
    }
    const effectiveDisplayName = renamedIdentity?.displayName;
    try {
      for (const targetInstallation of installationsToUpdate) {
        applyInstallationSettings(targetInstallation);
        if (effectiveDisplayName) targetInstallation.displayName = effectiveDisplayName;
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
        if (effectiveDisplayName) updates.name = effectiveDisplayName;
        if (instructions !== undefined) updates.instructions = instructions;
        if (persona !== undefined) updates.persona = persona;
        if (normalizedToolPolicy !== null) updates.toolPolicy = normalizedToolPolicy;
        if (normalizedContextPolicy !== null) updates.contextPolicy = normalizedContextPolicy;
        await AgentProfile.updateMany(
          {
            agentId: buildAgentProfileId(name, normalizedInstanceId),
            podId: { $in: writablePodIds },
          },
          { $set: updates },
          { runValidators: true },
        );

        if ((persona !== undefined || displayName) && normalizedInstanceId && name.toLowerCase() === 'openclaw') {
          const identityContent = buildIdentityContent(effectiveDisplayName || normalizedInstanceId, persona || {});
          writeWorkspaceIdentityFile(normalizedInstanceId, identityContent).catch((err: any) => {
            console.warn('[registry] Failed to sync IDENTITY.md for', normalizedInstanceId, err.message);
          });
        }
      }
    } catch (projectionError) {
      if (displayName !== undefined) {
        // A retry with the same name repairs any rows saved before this error.
        // The collision resolver accepts the same User principal, and every
        // projection write is idempotent. Expose the repair action explicitly
        // instead of reporting a generic 500 over a partially saved rename.
        console.error('Agent identity projection update interrupted');
        return res.status(503).json({
          code: 'identity_projection_retryable',
          error: 'Identity update interrupted. Save again to finish syncing pod names.',
        });
      }
      throw projectionError;
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

    if (renamedIdentity && !renamedIdentity.mirrorSynced) {
      return res.status(503).json({
        code: 'identity_mirror_pending',
        error: 'The name was saved, but chat is catching up. Save again in a moment.',
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
