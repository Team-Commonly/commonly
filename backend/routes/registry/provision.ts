// @ts-nocheck
// Agent provision route — extracted from registry.js (GH#112)
// Handles: POST /pods/:podId/agents/:name/provision
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const Pod = require('../../models/Pod');
const Integration = require('../../models/Integration');
const AgentIdentityService = require('../../services/agentIdentityService');
const DMService = require('../../services/dmService');
const {
  provisionAgentRuntime,
  startAgentRuntime,
  restartAgentRuntime,
  syncOpenClawSkills,
} = require('../../services/agentProvisionerService');
const {
  getUserId,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
  buildOpenClawIntegrationChannels,
  userHasPodAccess,
  isGlobalAdminUser,
  resolveGatewayForRequest,
  resolveGatewayForInstallation,
  resolveInstallation,
  resolveRuntimeInstanceId,
} = require('./helpers');
const {
  issueRuntimeTokenForAgent,
  issueUserTokenForInstallation,
} = require('./tokens');
const { PRESET_DEFINITIONS } = require('./presets');

const provisionRouter = express.Router();

/**
 * POST /api/registry/pods/:podId/agents/:name/provision
 * Provision an external runtime config for an agent instance (local dev).
 */
provisionRouter.post('/pods/:podId/agents/:name/provision', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const {
      instanceId,
      includeUserToken,
      label,
      scopes,
      force,
      gatewayId,
    } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    if (resolvedType === 'commonly-bot') {
      const isGlobalAdmin = await isGlobalAdminUser(userId);
      if (!isGlobalAdmin) {
        return res.status(403).json({ error: 'Global admin required to provision commonly-bot runtime' });
      }
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const resolved = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });
    const installation = resolved.installation;
    const normalizedInstanceId = resolveRuntimeInstanceId({
      agentName: name,
      requestedInstanceId: resolved.instanceId,
      installation,
    });

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const requesterId = userId?.toString?.() || userId;
    console.log(
      `[agent-provision] request pod=${podId} agent=${name} instance=${normalizedInstanceId} user=${requesterId} ip=${req.ip}`,
    );
    const runtimeTokens = installation.runtimeTokens || [];
    const lastRuntimeToken = runtimeTokens.length ? runtimeTokens[runtimeTokens.length - 1] : null;
    const lastProvisionTokenAt = lastRuntimeToken?.label?.toLowerCase?.().startsWith('provisioned')
      ? lastRuntimeToken.createdAt
      : null;
    const lastProvisionedAt = installation.config?.runtime?.provisionedAt || lastProvisionTokenAt;
    if (!force && lastProvisionedAt) {
      const minutesSinceProvision = (Date.now() - new Date(lastProvisionedAt).getTime()) / 60000;
      if (Number.isFinite(minutesSinceProvision) && minutesSinceProvision < 10) {
        console.warn(
          `[agent-provision] throttled pod=${podId} agent=${name} instance=${normalizedInstanceId} user=${requesterId} ip=${req.ip} minutes=${minutesSinceProvision.toFixed(2)}`,
        );
        return res.status(429).json({
          error: 'Provision already completed recently. Try again later or use force=true.',
        });
      }
    }

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(name.toLowerCase(), {
      instanceId: normalizedInstanceId,
      displayName: installation.displayName,
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    const runtimeIssued = await issueRuntimeTokenForAgent(
      agentUser,
      label || `Provisioned ${normalizedInstanceId}`,
      installation,
    );

    if (runtimeIssued.existing && force) {
      agentUser.agentRuntimeTokens = [];
      const freshToken = await issueRuntimeTokenForAgent(
        agentUser,
        label || `Provisioned ${normalizedInstanceId}`,
        installation,
      );
      Object.assign(runtimeIssued, freshToken);
    }

    let userIssued = null;
    if (includeUserToken || runtimeType === 'moltbot') {
      userIssued = await issueUserTokenForInstallation({
        agentName: name,
        instanceId: normalizedInstanceId,
        displayName: installation.displayName,
        podId,
        scopes,
        force,
      });
    }

    let eagerDmPod = null;
    try {
      eagerDmPod = await DMService.getOrCreateAdminDMPod(
        agentUser._id,
        installation.installedBy,
        { agentName: name, instanceId: normalizedInstanceId },
      );
    } catch (dmErr) {
      console.warn('[provision] Failed to pre-create shared DM pod:', dmErr.message);
    }

    const baseUrl = process.env.COMMONLY_API_URL
      || process.env.COMMONLY_BASE_URL
      || 'http://backend:5000';

    const configPayload = normalizeConfigMap(installation.config) || {};
    const runtimeAuthProfiles = normalizeRuntimeAuthProfiles(configPayload?.runtime?.authProfiles) || null;
    const runtimeSkillEnv = normalizeSkillEnvEntries(configPayload?.runtime?.skillEnv) || null;
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;

    if (eagerDmPod && configPayload?.heartbeat?.global === true && configPayload?.heartbeat?.enabled !== false) {
      try {
        const dmPodId = eagerDmPod._id.toString();
        const existing = await AgentInstallation.findOne({
          agentName: name.toLowerCase(),
          podId: dmPodId,
          instanceId: normalizedInstanceId,
        }).lean();
        if (!existing) {
          await AgentInstallation.install(name.toLowerCase(), dmPodId, {
            version: installation.version || '1.0.0',
            config: {
              heartbeat: {
                enabled: true,
                global: true,
                fixedPod: true,
                everyMinutes: configPayload.heartbeat.everyMinutes || 30,
              },
              errorRouting: { ownerDm: true },
            },
            scopes: installation.scopes || [],
            installedBy: installation.installedBy,
            instanceId: normalizedInstanceId,
            displayName: installation.displayName || normalizedInstanceId,
          });
          console.log(`[provision] Created fixedPod DM heartbeat installation for ${name}:${normalizedInstanceId} pod=${dmPodId}`);
        } else if (existing?.config?.heartbeat?.fixedPod !== true) {
          await AgentInstallation.updateOne(
            { _id: existing._id },
            { $set: { 'config.heartbeat.fixedPod': true, 'config.heartbeat.enabled': true, 'config.heartbeat.global': true } },
          );
          console.log(`[provision] Upgraded DM heartbeat installation to fixedPod for ${name}:${normalizedInstanceId}`);
        }
      } catch (dmInstErr) {
        console.warn('[provision] Failed to upsert DM pod heartbeat installation:', dmInstErr.message);
      }
    }

    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    let provisioned = { accountId: null, configPath: null, restartRequired: false };
    let integrationChannels = null;
    if (runtimeType === 'moltbot') {
      const integrations = await Integration.find({
        podId,
        status: 'connected',
        isActive: { $ne: false },
        type: { $in: ['discord', 'slack', 'telegram'] },
      })
        .select('_id type config channelName groupName chatTitle name')
        .lean();
      integrationChannels = buildOpenClawIntegrationChannels(integrations);
    }

    const shouldProvision = runtimeType === 'moltbot'
      || Boolean(runtimeIssued.token || runtimeAuthProfiles || runtimeSkillEnv);
    if (shouldProvision) {
      const explicitPresetId = configPayload?.presetId || null;
      const matchedPreset = PRESET_DEFINITIONS.find((p) => p.id === (explicitPresetId || normalizedInstanceId));
      const heartbeatForProvision = {
        ...(matchedPreset?.heartbeatTemplate ? { global: true, everyMinutes: 30 } : {}),
        ...(matchedPreset?.defaultHeartbeat || {}),
        ...(configPayload.heartbeat || {}),
        ...(matchedPreset?.heartbeatTemplate ? {
          customContent: matchedPreset.heartbeatTemplate,
          forceOverwrite: Boolean(explicitPresetId),
        } : {}),
        ...(matchedPreset?.soulTemplate ? { soulContent: matchedPreset.soulTemplate } : {}),
      };
      provisioned = await provisionAgentRuntime({
        runtimeType,
        agentName: name,
        instanceId: normalizedInstanceId,
        runtimeToken: runtimeIssued.token || null,
        userToken: userIssued?.token,
        baseUrl,
        displayName: installation.displayName,
        heartbeat: Object.keys(heartbeatForProvision).length ? heartbeatForProvision : null,
        gateway,
        authProfiles: runtimeAuthProfiles,
        skillEnv: runtimeSkillEnv,
        integrationChannels,
      });
    }

    const matchedPresetForSave = PRESET_DEFINITIONS.find((p) => p.id === normalizedInstanceId);
    if (matchedPresetForSave?.heartbeatTemplate) {
      try {
        await AgentProfile.updateMany(
          { agentName: name.toLowerCase(), instanceId: normalizedInstanceId, podId },
          { $set: { heartbeatContent: matchedPresetForSave.heartbeatTemplate } },
        );
      } catch (hbErr) {
        console.warn('[reprovision] Failed to persist heartbeatContent to AgentProfile:', hbErr.message);
      }
    }

    let runtimeStart = null;
    try {
      runtimeStart = await startAgentRuntime(runtimeType, normalizedInstanceId, { gateway });
    } catch (startError) {
      console.warn('Runtime start failed:', startError.message);
      runtimeStart = { started: false, reason: startError.message };
    }

    let runtimeRestart = null;
    if (provisioned.restartRequired) {
      try {
        runtimeRestart = await restartAgentRuntime(runtimeType, normalizedInstanceId, { gateway });
      } catch (restartError) {
        console.warn('Runtime restart failed:', restartError.message);
        runtimeRestart = { restarted: false, reason: restartError.message };
      }
    }

    let skillsSynced = null;
    if (name.toLowerCase() === 'openclaw') {
      const skillSync = configPayload?.skillSync || null;
      const mode = skillSync?.mode === 'selected' ? 'selected' : 'all';
      const requestedPodIds = Array.isArray(skillSync?.podIds)
        ? skillSync.podIds.map((id) => String(id)).filter(Boolean)
        : [String(podId)];
      let podIdsToSync = requestedPodIds;

      if (skillSync?.allPods) {
        const allInstallations = await AgentInstallation.find({
          agentName: name.toLowerCase(),
          instanceId: normalizedInstanceId,
          status: 'active',
        }).lean();
        podIdsToSync = allInstallations
          .map((i) => i.podId?.toString?.())
          .filter(Boolean);
      }

      if (podIdsToSync.length) {
        const pods = await Pod.find({ _id: { $in: podIdsToSync } })
          .select('members createdBy')
          .lean();
        podIdsToSync = pods
          .filter((p) => userHasPodAccess(p, userId))
          .map((p) => p._id.toString());
      }

      try {
        const skillsPath = await syncOpenClawSkills({
          accountId: normalizedInstanceId,
          podIds: podIdsToSync,
          mode,
          skillNames: Array.isArray(skillSync?.skillNames) ? skillSync.skillNames : [],
          gateway,
        });
        skillsSynced = { success: true, path: skillsPath, podIds: podIdsToSync };
      } catch (syncError) {
        console.warn('OpenClaw skill sync failed during provision:', syncError.message);
        skillsSynced = { success: false, error: syncError.message };
      }
    }

    const existingRuntimeConfig = { ...(normalizeConfigMap(installation.config)?.runtime || {}) };
    if (runtimeAuthProfiles) {
      existingRuntimeConfig.authProfiles = runtimeAuthProfiles;
    }
    if (runtimeSkillEnv) {
      existingRuntimeConfig.skillEnv = runtimeSkillEnv;
    }
    installation.config = installation.config || {};
    installation.config.runtime = {
      ...existingRuntimeConfig,
      status: 'provisioned',
      runtimeType,
      accountId: provisioned.accountId,
      configPath: provisioned.configPath,
      restartRequired: provisioned.restartRequired,
      runtimeStarted: runtimeStart?.started || false,
      runtimeStartCommand: runtimeStart?.command || null,
      gatewayId: gateway?._id || existingRuntimeConfig.gatewayId || null,
      gatewaySlug: gateway?.slug || existingRuntimeConfig.gatewaySlug || null,
      sharedGateway: runtimeStart?.sharedGateway || false,
      provisionedAt: new Date(),
    };
    await installation.save();

    return res.json({
      runtimeToken: runtimeIssued.token || null,
      runtimeTokenExisting: runtimeIssued.existing || false,
      runtimeTokenMessage: runtimeIssued.message || null,
      userToken: userIssued?.token || null,
      runtimeType,
      accountId: provisioned.accountId,
      configPath: provisioned.configPath,
      restartRequired: provisioned.restartRequired,
      runtimeStarted: runtimeStart?.started || false,
      runtimeStartCommand: runtimeStart?.command || null,
      runtimeStartError: runtimeStart?.reason || null,
      gatewayId: gateway?._id || null,
      gatewaySlug: gateway?.slug || null,
      sharedGateway: runtimeStart?.sharedGateway || false,
      runtimeRestarted: runtimeRestart?.restarted || false,
      runtimeRestartError: runtimeRestart?.reason || null,
      skillsSynced,
      sharedIdentity: true,
      agentUsername: agentUser.username,
    });
  } catch (error) {
    console.error('Error provisioning agent runtime:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to provision agent runtime' });
  }
});

module.exports = provisionRouter;
