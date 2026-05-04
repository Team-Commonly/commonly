// reprovisionInstallation — extracted from registry.js (GH#112)
// Shared by the provision route and the reprovision-all admin route.
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const Integration = require('../../models/Integration');
const AgentIdentityService = require('../../services/agentIdentityService');
const {
  provisionAgentRuntime,
  startAgentRuntime,
  restartAgentRuntime,
  syncOpenClawSkills,
  ensureWorkspaceIdentityFile,
} = require('../../services/agentProvisionerService');
const {
  normalizeInstanceId,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
  buildOpenClawIntegrationChannels,
  resolveGatewayForInstallation,
  buildIdentityContent,
  buildAgentProfileId,
} = require('./helpers');
const {
  issueRuntimeTokenForAgent,
  issueUserTokenForInstallation,
} = require('./tokens');
const { PRESET_DEFINITIONS } = require('./presets');
const { applyPresetDefaultSkills } = require('../../services/presetSkillsAutoImport');

const reprovisionInstallation = async ({
  installation,
  force = true,
  runtimeTokenCache = new Map(),
  userTokenCache = new Map(),
  skipRuntimeRestart = false,
}: {
  installation?: any;
  force?: boolean;
  runtimeTokenCache?: Map<any, any>;
  userTokenCache?: Map<any, any>;
  skipRuntimeRestart?: boolean;
} = {}) => {
  if (!installation) {
    throw new Error('Installation is required');
  }

  const podId = String(installation.podId || '').trim();
  const name = String(installation.agentName || '').trim().toLowerCase();
  const normalizedInstanceId = normalizeInstanceId(installation.instanceId);
  const identityKey = `${name}:${normalizedInstanceId}`;
  const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
  const runtimeType = typeConfig?.runtime;
  if (!runtimeType) {
    throw new Error('Unknown agent runtime type');
  }

  const agentUser = await AgentIdentityService.getOrCreateAgentUser(name, {
    instanceId: normalizedInstanceId,
    displayName: installation.displayName,
  });
  await AgentIdentityService.ensureAgentInPod(agentUser, podId);

  const issueLabel = `Bulk reprovision ${normalizedInstanceId}`;
  let runtimeToken = runtimeTokenCache.get(identityKey) || null;
  let runtimeIssued = {
    existing: Boolean(runtimeToken),
    token: runtimeToken,
    label: issueLabel,
  };
  if (!runtimeToken) {
    runtimeIssued = await issueRuntimeTokenForAgent(agentUser, issueLabel, installation);
    if (runtimeIssued.existing && force) {
      agentUser.agentRuntimeTokens = [];
      const freshToken = await issueRuntimeTokenForAgent(agentUser, issueLabel, installation);
      runtimeIssued = { ...runtimeIssued, ...freshToken };
    }
    runtimeToken = runtimeIssued.token || null;
    if (runtimeToken) {
      runtimeTokenCache.set(identityKey, runtimeToken);
    }
  }

  let userToken = userTokenCache.get(identityKey) || null;
  if (!userToken || runtimeType === 'moltbot') {
    if (!userToken) {
      const userIssued = await issueUserTokenForInstallation({
        agentName: name,
        instanceId: normalizedInstanceId,
        displayName: installation.displayName,
        podId,
        scopes: installation.scopes || [],
        force,
      });
      userToken = userIssued?.token || null;
      if (userToken) {
        userTokenCache.set(identityKey, userToken);
      }
    }
  }

  const baseUrl = process.env.COMMONLY_API_URL
    || process.env.COMMONLY_BASE_URL
    || 'http://backend:5000';
  const configPayload = normalizeConfigMap(installation.config) || {};
  const runtimeAuthProfiles = normalizeRuntimeAuthProfiles(configPayload?.runtime?.authProfiles) || null;
  const runtimeSkillEnv = normalizeSkillEnvEntries(configPayload?.runtime?.skillEnv) || null;
  const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
  const gateway = configuredGatewayId
    ? await resolveGatewayForInstallation({ gatewayId: configuredGatewayId })
    : null;

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

  // Prefer explicit presetId from installationConfig; fall back to instanceId matching
  const explicitPresetId = configPayload?.presetId || null;
  const matchedPreset = PRESET_DEFINITIONS.find((p: any) => p.id === (explicitPresetId || normalizedInstanceId));
  const heartbeatForProvision = {
    // Presets with a heartbeat template default to global=true: the agent iterates
    // its own pods during the heartbeat rather than firing once per pod.
    ...(matchedPreset?.heartbeatTemplate ? { global: true, everyMinutes: 30 } : {}),
    ...(matchedPreset?.defaultHeartbeat || {}),
    ...(configPayload.heartbeat || {}),
    ...(matchedPreset?.heartbeatTemplate ? {
      customContent: matchedPreset.heartbeatTemplate,
      // Force-overwrite only when preset was explicitly declared — preserves manual edits otherwise
      forceOverwrite: Boolean(explicitPresetId),
    } : {}),
    ...(matchedPreset?.soulTemplate ? { soulContent: matchedPreset.soulTemplate } : {}),
    // Customization flags — provisioner honors user edits to SOUL.md/HEARTBEAT.md
    customizations: configPayload.customizations || null,
  };
  const provisioned = await provisionAgentRuntime({
    runtimeType,
    agentName: name,
    instanceId: normalizedInstanceId,
    runtimeToken: runtimeToken || null,
    userToken,
    baseUrl,
    displayName: installation.displayName,
    heartbeat: Object.keys(heartbeatForProvision).length ? heartbeatForProvision : null,
    gateway,
    authProfiles: runtimeAuthProfiles,
    skillEnv: runtimeSkillEnv,
    integrationChannels,
  });

  // Persist heartbeat template to AgentProfile so config card reflects it
  if (matchedPreset?.heartbeatTemplate) {
    try {
      await AgentProfile.updateMany(
        { agentName: name.toLowerCase(), instanceId: normalizedInstanceId, podId },
        { $set: { heartbeatContent: matchedPreset.heartbeatTemplate } },
      );
    } catch (hbErr: unknown) {
      console.warn('[provision] Failed to persist heartbeatContent to AgentProfile:', (hbErr as Error).message);
    }
  }

  // ADR-013 Phase 1: auto-import the preset's defaultSkills as PodAssets so
  // syncOpenClawSkills (called below) picks them up and writes their SKILL.md
  // files to the agent's workspace on the gateway PVC. Reuses the same
  // upsertImportedSkillAsset path the manual /api/skills/import route uses;
  // idempotent across reprovisions.
  let presetSkillsApplied = null;
  if (matchedPreset?.defaultSkills?.length && podId) {
    try {
      presetSkillsApplied = await applyPresetDefaultSkills({
        podId: String(podId),
        preset: matchedPreset,
        userId: installation.installedBy || null,
      });
    } catch (skillErr: unknown) {
      console.warn(
        '[reprovision] applyPresetDefaultSkills failed:',
        (skillErr as Error).message,
      );
      presetSkillsApplied = { error: (skillErr as Error).message };
    }
  }

  let runtimeStart = null;
  try {
    runtimeStart = await startAgentRuntime(runtimeType, normalizedInstanceId, { gateway });
  } catch (startError: unknown) {
    runtimeStart = { started: false, reason: (startError as Error).message };
  }

  let runtimeRestart = null;
  if (provisioned.restartRequired && !skipRuntimeRestart) {
    try {
      runtimeRestart = await restartAgentRuntime(runtimeType, normalizedInstanceId, { gateway });
    } catch (restartError: unknown) {
      runtimeRestart = { restarted: false, reason: (restartError as Error).message };
    }
  }

  let skillsSynced = null;
  if (name === 'openclaw') {
    const skillSync = configPayload?.skillSync || null;
    const mode = skillSync?.mode === 'selected' ? 'selected' : 'all';
    let podIdsToSync = Array.isArray(skillSync?.podIds)
      ? skillSync.podIds.map((id: any) => String(id)).filter(Boolean)
      : [podId];
    if (skillSync?.allPods) {
      const allInstallations = await AgentInstallation.find({
        agentName: name,
        instanceId: normalizedInstanceId,
        status: 'active',
      }).lean();
      podIdsToSync = allInstallations
        .map((i: any) => i.podId?.toString?.())
        .filter(Boolean);
    }
    try {
      const pathSynced = await syncOpenClawSkills({
        accountId: normalizedInstanceId,
        podIds: podIdsToSync,
        mode,
        skillNames: Array.isArray(skillSync?.skillNames) ? skillSync.skillNames : [],
        gateway,
      });
      skillsSynced = { success: true, path: pathSynced, podIds: podIdsToSync };
    } catch (syncError: unknown) {
      skillsSynced = { success: false, error: (syncError as Error).message };
    }
  }

  // Seed IDENTITY.md from AgentProfile persona on provision (skip if agent already has custom identity)
  if (name.toLowerCase() === 'openclaw' && normalizedInstanceId) {
    const profileForIdentity = await AgentProfile.findOne({
      agentId: buildAgentProfileId(name, normalizedInstanceId),
      podId,
    }).lean();
    const p = profileForIdentity?.persona;
    if (p && (p.tone || p.specialties?.length || p.customInstructions)) {
      const identityContent = buildIdentityContent(
        installation.displayName || normalizedInstanceId,
        p,
      );
      ensureWorkspaceIdentityFile(normalizedInstanceId, identityContent, { gateway }).catch((err: unknown) => {
        console.warn('[registry] Failed to seed IDENTITY.md on provision:', (err as Error).message);
      });
    }
  }

  const existingRuntimeConfig = { ...(normalizeConfigMap(installation.config)?.runtime || {}) };
  if (runtimeAuthProfiles) existingRuntimeConfig.authProfiles = runtimeAuthProfiles;
  if (runtimeSkillEnv) existingRuntimeConfig.skillEnv = runtimeSkillEnv;
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

  return {
    installationId: installation._id?.toString(),
    podId,
    agentName: name,
    instanceId: normalizedInstanceId,
    runtimeType,
    runtimeStarted: runtimeStart?.started || false,
    runtimeRestarted: runtimeRestart?.restarted || false,
    runtimeStartError: runtimeStart?.reason || null,
    runtimeRestartError: runtimeRestart?.reason || null,
    tokenRotated: Boolean(runtimeIssued.token),
    skillsSynced,
    presetSkillsApplied,
  };
};

module.exports = { reprovisionInstallation };

export {};
