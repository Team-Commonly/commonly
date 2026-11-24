// reprovisionInstallation — extracted from registry.js (GH#112)
// Shared by the provision route and the reprovision-all admin route.
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const AgentIdentityService = require('../../services/agentIdentityService');
const { assertAgentRuntimeMayJoinPod } = require('../../services/outsiderGrantAgentJoinPolicy');
const { hostedEngineInEffect } = require('../../services/hostedEngine');
const { installationIdentityFilter, IDENTITY_COLLATION } = require('../../services/agentInstallationIdentity');
const {
  provisionAgentRuntime,
  runtimeReceivesToken,
  startAgentRuntime,
  restartAgentRuntime,
} = require('../../services/agentProvisionerService');
const { moltbotRuntimeRetired } = require('../../services/retiredRuntime');
const {
  normalizeInstanceId,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
} = require('./helpers');
const {
  revokeRuntimeTokensForAgent,
  issueRuntimeTokenForAgent,
  issueUserTokenForInstallation,
} = require('./tokens');
const { PRESET_DEFINITIONS, withCyclesDirective } = require('./presets');

// A token issued here reaches a seat only through the provisioner. A seat outside
// it has no way to learn the new one, so revoking its token takes it offline.
// The row is provisioned by its type's runtime but may store another, so both
// have to receive the token (F250).
const keepsItsOwnToken = (installation: any, typeRuntime?: string) => {
  const runtime = normalizeConfigMap(installation?.config)?.runtime || {};
  if (String(runtime.host || '').trim().toLowerCase() === 'byo') return true;
  const runtimes = [runtime.runtimeType, typeRuntime].filter(Boolean);
  return !runtimes.length || runtimes.some((value) => !runtimeReceivesToken(value));
};

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
  const skipped = (skipReason: string) => ({
    installationId: installation._id?.toString(),
    podId,
    agentName: name,
    instanceId: normalizedInstanceId,
    runtimeType: normalizeConfigMap(installation.config)?.runtime?.runtimeType || runtimeType || null,
    skipped: true,
    skipReason,
  });
  if (keepsItsOwnToken(installation, runtimeType)) return skipped('keeps_its_own_token');
  if (!runtimeType) return skipped('unknown_runtime');
  await assertAgentRuntimeMayJoinPod(podId, runtimeType, hostedEngineInEffect(installation));

  // A revoke reaches every install of this identity, not only this row: the
  // identity's User, which a legacy alias name shares, and on the default
  // instance a row stored with no instance id (installationIdentityFilter).
  const sameIdentity = await AgentInstallation.find({
    ...installationIdentityFilter(name, normalizedInstanceId),
    agentName: { $in: AgentIdentityService.identityNames(name) },
    status: { $in: ['active', 'paused'] },
  }).collation(IDENTITY_COLLATION).select('config').lean();
  if (sameIdentity.some((row: any) => keepsItsOwnToken(row, runtimeType))) {
    return skipped('shares_identity_with_external_seat');
  }

  // The runtime is retired (ADR-021 Part B): nothing would start it, so no token
  // is issued. Skipped, so a bulk run carries on. This check stays after the
  // token-ownership skips above, which a stored moltbot row passes because
  // runtimeReceivesToken still lists 'moltbot'.
  if (moltbotRuntimeRetired(runtimeType)) return skipped('runtime_retired');

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
    if (force) {
      await revokeRuntimeTokensForAgent({
        agentUser,
        agentName: name,
        instanceId: normalizedInstanceId,
        installation,
      });
    }
    runtimeIssued = await issueRuntimeTokenForAgent(agentUser, issueLabel, installation);
    runtimeToken = runtimeIssued.token || null;
    if (runtimeToken) {
      runtimeTokenCache.set(identityKey, runtimeToken);
    }
  }

  let userToken = userTokenCache.get(identityKey) || null;
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

  const baseUrl = process.env.COMMONLY_API_URL
    || process.env.COMMONLY_BASE_URL
    || 'http://backend:5000';
  const configPayload = normalizeConfigMap(installation.config) || {};
  const runtimeAuthProfiles = normalizeRuntimeAuthProfiles(configPayload?.runtime?.authProfiles) || null;
  const runtimeSkillEnv = normalizeSkillEnvEntries(configPayload?.runtime?.skillEnv) || null;
  // Prefer explicit presetId from installationConfig; fall back to instanceId matching
  const explicitPresetId = configPayload?.presetId || null;
  const matchedPreset = PRESET_DEFINITIONS.find((p: any) => p.id === (explicitPresetId || normalizedInstanceId));
  const heartbeatForProvision = {
    // Presets with a heartbeat template fire on a 30m cadence.
    ...(matchedPreset?.heartbeatTemplate ? { everyMinutes: 30 } : {}),
    ...(matchedPreset?.defaultHeartbeat || {}),
    ...(configPayload.heartbeat || {}),
    ...(matchedPreset?.heartbeatTemplate ? {
      customContent: withCyclesDirective(matchedPreset.heartbeatTemplate),
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
  });

  // Persist heartbeat template to AgentProfile so config card reflects it
  if (matchedPreset?.heartbeatTemplate) {
    try {
      await AgentProfile.updateMany(
        { agentName: name.toLowerCase(), instanceId: normalizedInstanceId, podId },
        { $set: { heartbeatContent: withCyclesDirective(matchedPreset.heartbeatTemplate) } },
      );
    } catch (hbErr: unknown) {
      console.warn('[provision] Failed to persist heartbeatContent to AgentProfile:', (hbErr as Error).message);
    }
  }

  let runtimeStart = null;
  try {
    runtimeStart = await startAgentRuntime(runtimeType, normalizedInstanceId);
  } catch (startError: unknown) {
    runtimeStart = { started: false, reason: (startError as Error).message };
  }

  let runtimeRestart = null;
  if (provisioned.restartRequired && !skipRuntimeRestart) {
    try {
      runtimeRestart = await restartAgentRuntime(runtimeType, normalizedInstanceId);
    } catch (restartError: unknown) {
      runtimeRestart = { restarted: false, reason: (restartError as Error).message };
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
  };
};

module.exports = { reprovisionInstallation };

export {};
