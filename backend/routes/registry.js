/**
 * Agent Registry Routes
 *
 * API for the agent "package manager" - discover, install, configure agents.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');

const router = express.Router();
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');
const AgentProfile = require('../models/AgentProfile');
const Activity = require('../models/Activity');
const Pod = require('../models/Pod');
const User = require('../models/User');
const Gateway = require('../models/Gateway');
const Integration = require('../models/Integration');
const AgentTemplate = require('../models/AgentTemplate');
const AgentIdentityService = require('../services/agentIdentityService');
const AgentEventService = require('../services/agentEventService');
const DMService = require('../services/dmService');
const { generateText } = require('../services/llmService');
const {
  provisionAgentRuntime,
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
  clearAgentRuntimeSessions,
  isK8sMode,
  listOpenClawPlugins,
  listOpenClawBundledSkills,
  installOpenClawPlugin,
  writeOpenClawHeartbeatFile,
  readOpenClawHeartbeatFile,
  readOpenClawIdentityFile,
  writeWorkspaceIdentityFile,
  ensureWorkspaceIdentityFile,
  syncOpenClawSkills,
  resolveOpenClawAccountId,
} = require('../services/agentProvisionerService');
const { hash, randomSecret } = require('../utils/secret');
const {
  ManifestValidationError,
  normalizePublishPayload,
} = require('../utils/agentManifestRegistry');

const {
  buildIdentityContent,
  parseVerifiedFilter,
  escapeRegExp,
  getUserId,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
  sanitizeRuntimeConfig,
  buildOpenClawIntegrationChannels,
  buildAgentInstallationPayload,
  normalizePluginIdentifier,
  getPluginSpecBase,
  normalizeInstanceId,
  normalizeDisplayName,
  buildRuntimeLogFilters,
  resolveGatewayForRequest,
  isGlobalAdminUser,
  resolveGatewayForInstallation,
  userHasPodAccess,
  parseJsonFromText,
  serializeRuntimeTokens,
  parseEnvFlag,
  hasAnyEnv,
} = require('./registry/helpers');

const {
  detectGatewayPresetCapabilities,
  detectBuiltInOpenClawSkills,
  detectDockerfileCommonlyPackages,
  binLooksInstalled,
} = require('./registry/detect');

const { PRESET_DEFINITIONS } = require('./registry/presets');

const resolvePresetTool = (tool, capabilities) => {
  if (tool.type === 'core') {
    return { ...tool, available: true };
  }
  if (tool.type === 'plugin') {
    const pluginSpecs = (capabilities.plugins || [])
      .map((plugin) => `${plugin.name || ''} ${plugin.spec || ''}`.toLowerCase());
    const available = (tool.matchAny || []).some((needle) => pluginSpecs.some((spec) => spec.includes(needle)));
    return { ...tool, available };
  }
  return { ...tool, available: false };
};

const resolvePresetApiRequirement = (requirement) => ({
  ...requirement,
  configured: hasAnyEnv(requirement.envAny || [requirement.key]),
});

const resolvePresetSkills = ({ preset, builtInSkills, dockerCapabilities }) => {
  const skillMap = new Map((builtInSkills.skills || []).map((skill) => [skill.id, skill]));
  const defaultSkills = Array.isArray(preset.defaultSkills) ? preset.defaultSkills : [];
  return defaultSkills.map((entry) => {
    const builtIn = skillMap.get(entry.id);
    const requiresBins = Array.isArray(builtIn?.requiresBins) ? builtIn.requiresBins : [];
    const requiresEnv = Array.isArray(builtIn?.requiresEnv) ? builtIn.requiresEnv : [];
    const binsReady = requiresBins.every((bin) => binLooksInstalled(bin, dockerCapabilities));
    const envReady = requiresEnv.every((envName) => hasAnyEnv([envName]));
    const binStatus = requiresBins.map((bin) => ({
      bin,
      installed: binLooksInstalled(bin, dockerCapabilities),
    }));
    const envStatus = requiresEnv.map((envKey) => ({
      key: envKey,
      configured: hasAnyEnv([envKey]),
    }));
    let setupStatus = 'ready';
    if (!builtIn) setupStatus = 'missing-skill';
    else if (!binsReady) setupStatus = 'needs-package-install';
    else if (!envReady) setupStatus = 'needs-api-env';
    return {
      id: entry.id,
      reason: entry.reason || '',
      available: Boolean(builtIn),
      requirements: {
        bins: requiresBins,
        env: requiresEnv,
      },
      binStatus,
      envStatus,
      setupStatus,
      readiness: {
        binsReady,
        envReady,
        ready: Boolean(builtIn) && binsReady && envReady,
      },
    };
  });
};

router.get('/presets', auth, async (req, res) => {
  try {
    const capabilities = await detectGatewayPresetCapabilities();
    const builtInSkills = detectBuiltInOpenClawSkills();
    const dockerCapabilities = detectDockerfileCommonlyPackages();
    const presets = PRESET_DEFINITIONS.map((preset) => {
      const resolvedSkills = resolvePresetSkills({
        preset,
        builtInSkills,
        dockerCapabilities,
      });
      const recommendedEnvMap = new Map();
      (preset.apiRequirements || []).forEach((requirement) => {
        const key = String(requirement.key || '').trim();
        if (!key) return;
        recommendedEnvMap.set(key, {
          key,
          purpose: requirement.purpose || '',
          configured: hasAnyEnv(requirement.envAny || [key]),
          source: 'preset-api',
        });
      });
      resolvedSkills.forEach((skill) => {
        (skill.envStatus || []).forEach((envEntry) => {
          if (!envEntry?.key) return;
          if (!recommendedEnvMap.has(envEntry.key)) {
            recommendedEnvMap.set(envEntry.key, {
              key: envEntry.key,
              purpose: `Required by skill ${skill.id}`,
              configured: Boolean(envEntry.configured),
              source: 'skill',
            });
          }
        });
      });
      return {
        ...preset,
        requiredTools: (preset.requiredTools || []).map(
          (tool) => resolvePresetTool(tool, capabilities),
        ),
        apiRequirements: (preset.apiRequirements || []).map(resolvePresetApiRequirement),
        defaultSkills: resolvedSkills,
        recommendedEnv: Array.from(recommendedEnvMap.values()),
        readiness: (() => {
        const toolsReady = (preset.requiredTools || [])
          .every((tool) => resolvePresetTool(tool, capabilities).available);
        const apisReady = (preset.apiRequirements || [])
          .every((requirement) => hasAnyEnv(requirement.envAny || [requirement.key]));
        const skillsReady = resolvedSkills.every((skill) => skill.readiness.ready);
        return {
          toolsReady,
          apisReady,
          skillsReady,
          ready: toolsReady && apisReady && skillsReady,
        };
        })(),
      };
    });

    return res.json({
      presets,
      capabilities,
      runtimeSkills: builtInSkills,
      dockerCapabilities,
    });
  } catch (error) {
    console.error('Error listing agent presets:', error);
    return res.status(500).json({ error: 'Failed to list agent presets' });
  }
});

/**
 * Derive instanceId from displayName for consistent agent identity across pods.
 * This ensures the same agent (e.g., "Cuz") gets the same instanceId regardless
 * of which pod it's installed in, allowing shared runtime tokens and memory.
 *
 * @param {string} displayName - The display name (e.g., "Cuz", "Tarik")
 * @param {string} agentName - The base agent name (e.g., "openclaw")
 * @returns {string} - The derived instanceId (e.g., "cuz", "tarik", or "default")
 */
const deriveInstanceId = (displayName, agentName) => {
  if (!displayName) return 'default';
  const slug = String(displayName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  // If slug matches agentName or is empty, use 'default'
  if (!slug || slug === agentName.toLowerCase()) {
    return 'default';
  }
  return slug;
};

const resolveRuntimeInstanceId = ({ agentName, requestedInstanceId, installation }) => {
  // Runtime identity must follow the installed instance exactly.
  // Do not derive a different runtime instance from displayName, otherwise
  // shared tokens can drift and runtime pod authorization fails.
  const installedInstanceId = normalizeInstanceId(installation?.instanceId);
  if (installedInstanceId) return installedInstanceId;

  return normalizeInstanceId(requestedInstanceId);
};

/**
 * Check if an agent instance already exists globally (across all pods).
 * Returns the existing installations and agent user if found.
 *
 * @param {string} agentName - The base agent name
 * @param {string} instanceId - The instance identifier
 * @returns {Object} - { exists, installations, agentUser }
 */
const findExistingAgentInstance = async (agentName, instanceId) => {
  const installations = await AgentInstallation.find({
    agentName: agentName.toLowerCase(),
    instanceId,
    status: 'active',
  }).lean();

  if (installations.length === 0) {
    return { exists: false, installations: [], agentUser: null };
  }

  const username = AgentIdentityService.buildAgentUsername(agentName, instanceId);
  const agentUser = await User.findOne({
    username,
    isBot: true,
  }).lean();

  return { exists: true, installations, agentUser };
};

const resolveInstallation = async ({ agentName, podId, instanceId }) => {
  const normalizedInstanceId = normalizeInstanceId(instanceId);
  let installation = await AgentInstallation.findOne({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId: normalizedInstanceId,
  });

  if (installation) {
    return { installation, instanceId: normalizedInstanceId };
  }

  // Fallback: if instanceId is default and there is exactly one install, use it.
  if (normalizedInstanceId === 'default') {
    const installs = await AgentInstallation.find({
      agentName: agentName.toLowerCase(),
      podId,
      status: { $ne: 'uninstalled' },
    }).limit(2);
    if (installs.length === 1) {
      return { installation: installs[0], instanceId: installs[0].instanceId || 'default' };
    }
  }

  // Fallback: if a specific instanceId was provided but there is exactly one active install,
  // use it to avoid hard failures when the UI doesn't know the instanceId.
  const activeInstalls = await AgentInstallation.find({
    agentName: agentName.toLowerCase(),
    podId,
    status: { $ne: 'uninstalled' },
  }).limit(2);
  if (activeInstalls.length === 1) {
    return { installation: activeInstalls[0], instanceId: activeInstalls[0].instanceId || 'default' };
  }

  return { installation: null, instanceId: normalizedInstanceId };
};

const buildAgentProfileId = (agentName, instanceId) => (
  `${agentName.toLowerCase()}:${normalizeInstanceId(instanceId)}`
);

const {
  AGENT_USER_TOKEN_SCOPES,
  normalizeScopes,
  AUTO_GRANTED_INTEGRATION_SCOPES,
  sanitizeStringList,
  normalizeToolPolicy,
  normalizeContextPolicy,
  issueRuntimeTokenForAgent,
  issueRuntimeTokenForInstallation,
  issueUserTokenForInstallation,
} = require('./registry/tokens');
/**
 * POST /api/registry/install
 * Install an agent to a pod
 */
router.post('/install', auth, async (req, res) => {
  try {
    const {
      agentName, podId, version, config = {}, scopes = [], instanceId, displayName, gatewayId,
    } = req.body;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify agent exists
    const agent = await AgentRegistry.getByName(agentName);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found in registry' });
    }

    // Verify user has admin access to pod
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    // Check membership - handle both ObjectId array and object array with userId
    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });
    const memberRole = membership?.role || (isCreator ? 'admin' : null);

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'You must be a member of this pod' });
    }

    // For now, allow any member to install (can tighten later)
    // if (memberRole !== 'admin' && !isCreator) {
    //   return res.status(403).json({ error: 'Admin access required to install agents' });
    // }

    // Derive instanceId from displayName for consistent identity across pods
    // If explicit instanceId provided, use it; otherwise derive from displayName
    let normalizedInstanceId;
    if (instanceId) {
      normalizedInstanceId = normalizeInstanceId(instanceId);
      if (normalizedInstanceId === agentName.toLowerCase()) {
        normalizedInstanceId = 'default';
      }
    } else {
      // Derive from displayName for consistent identity
      normalizedInstanceId = deriveInstanceId(displayName, agentName);
    }

    // Check if already installed in THIS pod
    const existingInPod = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      podId,
      instanceId: normalizedInstanceId,
      status: 'active',
    });

    if (existingInPod) {
      return res.status(400).json({ error: 'Agent already installed in this pod' });
    }

    // Check if this agent instance exists in OTHER pods (for shared identity)
    const globalAgent = await findExistingAgentInstance(agentName, normalizedInstanceId);
    const isReusingExistingAgent = globalAgent.exists;

    // Validate scopes against manifest
    const requiredScopes = agent.manifest.context?.required || [];
    const missingScopes = requiredScopes.filter((s) => !scopes.includes(s));
    if (missingScopes.length > 0) {
      return res.status(400).json({
        error: 'Missing required scopes',
        missingScopes,
      });
    }

    const installConfig = normalizeConfigMap(config) || {};
    const runtimeConfig = typeof installConfig.runtime === 'object' && installConfig.runtime
      ? { ...installConfig.runtime }
      : {};
    const normalizedAuthProfiles = normalizeRuntimeAuthProfiles(runtimeConfig.authProfiles);
    if (normalizedAuthProfiles) {
      runtimeConfig.authProfiles = normalizedAuthProfiles;
    }
    const normalizedSkillEnv = normalizeSkillEnvEntries(runtimeConfig.skillEnv);
    if (normalizedSkillEnv) {
      runtimeConfig.skillEnv = normalizedSkillEnv;
    }
    let resolvedGateway = null;
    if (gatewayId) {
      resolvedGateway = await resolveGatewayForRequest({ gatewayId, userId });
      runtimeConfig.gatewayId = resolvedGateway._id.toString();
    }
    if (Object.keys(runtimeConfig).length) {
      installConfig.runtime = runtimeConfig;
    }

    const grantedScopes = Array.from(new Set([
      ...requiredScopes,
      ...scopes,
      ...AUTO_GRANTED_INTEGRATION_SCOPES,
    ]));

    // Create installation
    const installation = await AgentInstallation.install(agentName, podId, {
      version: version || agent.latestVersion,
      config: installConfig,
      scopes: grantedScopes,
      installedBy: userId,
      instanceId: normalizedInstanceId,
      displayName: displayName || agent.displayName,
    });

    // Create agent profile for the pod
    await AgentProfile.create({
      agentId: buildAgentProfileId(agentName, normalizedInstanceId),
      agentName: agentName.toLowerCase(),
      instanceId: normalizedInstanceId,
      podId,
      name: displayName || agent.displayName,
      purpose: agent.description,
      instructions: agent.manifest.configSchema?.defaultInstructions || '',
      persona: {
        tone: 'friendly',
        specialties: agent.manifest.capabilities?.map((c) => c.name) || [],
      },
      toolPolicy: {
        allowed: grantedScopes.filter((s) => s.includes(':')).map((s) => s.split(':')[0]),
      },
      createdBy: userId,
    });

    try {
      const agentUser = await AgentIdentityService.getOrCreateAgentUser(agent.agentName, {
        instanceId: normalizedInstanceId,
        displayName: displayName || agent.displayName,
      });
      await AgentIdentityService.ensureAgentInPod(agentUser, podId);
    } catch (identityError) {
      console.warn('Failed to provision agent user identity:', identityError.message);
    }

    // Increment install count
    await AgentRegistry.incrementInstalls(agentName);

    // Create activity for the installation
    try {
      const user = await User.findById(userId).select('username').lean();

      await Activity.create({
        type: 'agent_action',
        actor: {
          id: userId,
          name: user?.username || 'Unknown',
          type: 'human',
          verified: false,
        },
        action: 'agent_action',
        content: `Installed agent "${agent.displayName}" to this pod`,
        podId,
        agentMetadata: {
          agentName: agent.agentName,
        },
      });
    } catch (activityError) {
      console.warn('Failed to create activity for agent install:', activityError.message);
    }

    // Build list of other pods where this agent is installed (for UI info)
    const otherPodIds = isReusingExistingAgent
      ? globalAgent.installations
        .filter((i) => i.podId.toString() !== podId)
        .map((i) => i.podId)
      : [];

    res.json({
      success: true,
      installation: {
        id: installation._id.toString(),
        agentName: installation.agentName,
        instanceId: installation.instanceId || normalizedInstanceId,
        displayName: installation.displayName,
        version: installation.version,
        status: installation.status,
        scopes: installation.scopes,
        runtime: sanitizeRuntimeConfig(installConfig.runtime) || null,
      },
      // Indicate if this agent already existed in other pods (shared identity)
      sharedIdentity: isReusingExistingAgent,
      otherPods: otherPodIds,
      hasExistingRuntimeToken: globalAgent.agentUser?.agentRuntimeTokens?.length > 0,
    });
  } catch (error) {
    console.error('Error installing agent:', error);
    res.status(500).json({ error: error.message || 'Failed to install agent' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/provision
 * Provision an external runtime config for an agent instance (local dev).
 */
router.post('/pods/:podId/agents/:name/provision', auth, async (req, res) => {
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

    // Get or create the agent user (shared identity across pods)
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(name.toLowerCase(), {
      instanceId: normalizedInstanceId,
      displayName: installation.displayName,
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    // Issue runtime token using shared User model
    // If agent already has a token, this will return info about existing token
    const runtimeIssued = await issueRuntimeTokenForAgent(
      agentUser,
      label || `Provisioned ${normalizedInstanceId}`,
      installation, // Also store on installation for backward compat
    );

    // If existing token was found and force=true, revoke and regenerate
    if (runtimeIssued.existing && force) {
      // Clear existing tokens and generate new
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

    // Eagerly create the single shared DM pod (agent + installer + all admins).
    // This is the only DM pod per agent instance — installer and admins share one channel.
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

    // If this agent has a global heartbeat, ensure the DM pod has a pinned AgentInstallation
    // (fixedPod:true) so the scheduler always routes the heartbeat there instead of topic pods.
    // This is idempotent — repeated provisions leave existing configs untouched.
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
          // Retroactively upgrade an existing DM pod installation to use fixedPod
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

    // Only provision if we have a new token (not existing)
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
    // For OpenClaw, always re-run provisioning so shared-instance settings apply across pods
    // even when the runtime token already exists and no new raw token is returned.
    const shouldProvision = runtimeType === 'moltbot'
      || Boolean(runtimeIssued.token || runtimeAuthProfiles || runtimeSkillEnv);
    if (shouldProvision) {
      const explicitPresetId2 = configPayload?.presetId || null;
      const matchedPreset2 = PRESET_DEFINITIONS.find((p) => p.id === (explicitPresetId2 || normalizedInstanceId));
      const heartbeatForProvision2 = {
        ...(matchedPreset2?.heartbeatTemplate ? { global: true, everyMinutes: 30 } : {}),
        ...(matchedPreset2?.defaultHeartbeat || {}),
        ...(configPayload.heartbeat || {}),
        ...(matchedPreset2?.heartbeatTemplate ? {
          customContent: matchedPreset2.heartbeatTemplate,
          forceOverwrite: Boolean(explicitPresetId2),
        } : {}),
        ...(matchedPreset2?.soulTemplate ? { soulContent: matchedPreset2.soulTemplate } : {}),
      };
      provisioned = await provisionAgentRuntime({
        runtimeType,
        agentName: name,
        instanceId: normalizedInstanceId,
        runtimeToken: runtimeIssued.token || null,
        userToken: userIssued?.token,
        baseUrl,
        displayName: installation.displayName,
        heartbeat: Object.keys(heartbeatForProvision2).length ? heartbeatForProvision2 : null,
        gateway,
        authProfiles: runtimeAuthProfiles,
        skillEnv: runtimeSkillEnv,
        integrationChannels,
      });
    }

    // Persist heartbeat template to AgentProfile so config card reflects it
    const matchedPreset2ForSave = PRESET_DEFINITIONS.find((p) => p.id === normalizedInstanceId);
    if (matchedPreset2ForSave?.heartbeatTemplate) {
      try {
        await AgentProfile.updateMany(
          { agentName: name.toLowerCase(), instanceId: normalizedInstanceId, podId },
          { $set: { heartbeatContent: matchedPreset2ForSave.heartbeatTemplate } },
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
      // Indicate this is a shared agent identity
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

router.use(require('./registry/runtime'));
router.use(require('./registry/templates'));
router.use(require('./registry/catalog'));
router.use(require('./registry/admin'));
router.use(require('./registry/agent-tokens'));
router.use(require('./registry/pod-agents'));

/**
 * GET /api/registry/pods/:podId/agents/:name/plugins
 * List OpenClaw plugins for the selected/runtime gateway.
 */
router.use(require('./registry/plugins'));

router.use(require('./registry/files'));

/**
 * PATCH /api/registry/pods/:podId/agents/:name
 * Update agent configuration in a pod
 */
router.patch('/pods/:podId/agents/:name', auth, async (req, res) => {
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

    // Verify user has access to pod
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    // Check membership - handle both ObjectId array and object array
    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Find installation
    const installation = await AgentInstallation.findOne({
      agentName: name.toLowerCase(),
      podId,
      instanceId: normalizedInstanceId,
    });

    if (!installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const applyInstallationSettings = (targetInstallation) => {
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
      peerInstallations.map((entry) => [entry.podId?.toString?.() || '', entry]),
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
        .filter((entry) => userHasPodAccess(entry, userId))
        .map((entry) => entry._id.toString());
      if (!accessiblePodIds.includes(podId.toString())) {
        accessiblePodIds.push(podId.toString());
      }
    }

    const accessiblePodSet = new Set(accessiblePodIds);
    const installationsToUpdate = Array.from(peerByPod.entries())
      .filter(([entryPodId]) => accessiblePodSet.has(entryPodId))
      .map(([, entry]) => entry);

    for (const targetInstallation of installationsToUpdate) {
      applyInstallationSettings(targetInstallation);
      // eslint-disable-next-line no-await-in-loop
      await targetInstallation.save();
    }

    // Update agent profile if needed
    if (
      status
      || modelPreferences
      || displayName
      || instructions !== undefined
      || persona !== undefined
      || normalizedToolPolicy !== null
      || normalizedContextPolicy !== null
    ) {
      const updates = {};
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
          podId: { $in: accessiblePodIds },
        },
        updates,
      );

      // Sync persona/displayName to workspace IDENTITY.md so agents reflect it at runtime
      if ((persona !== undefined || displayName) && normalizedInstanceId && name.toLowerCase() === 'openclaw') {
        const identityContent = buildIdentityContent(displayName || normalizedInstanceId, persona || {});
        writeWorkspaceIdentityFile(normalizedInstanceId, identityContent).catch((err) => {
          console.warn('[registry] Failed to sync IDENTITY.md for', normalizedInstanceId, err.message);
        });
      }
    }

    const skillSync = config?.skillSync || null;
    if (skillSync && name.toLowerCase() === 'openclaw') {
      const mode = skillSync.mode === 'selected' ? 'selected' : 'all';
      const requestedPodIds = Array.isArray(skillSync.podIds)
        ? skillSync.podIds.map((id) => String(id)).filter(Boolean)
        : [];
      let podIdsToSync = requestedPodIds;
      if (skillSync.allPods) {
        const installations = await AgentInstallation.find({
          agentName: name.toLowerCase(),
          instanceId: normalizedInstanceId,
          status: 'active',
        }).lean();
        podIdsToSync = installations.map((i) => i.podId?.toString?.()).filter(Boolean);
      }
      if (podIdsToSync.length) {
        const pods = await Pod.find({ _id: { $in: podIdsToSync } })
          .select('members createdBy')
          .lean();
        podIdsToSync = pods
          .filter((p) => userHasPodAccess(p, userId))
          .map((p) => p._id.toString());
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
      updatedPods: accessiblePodIds.length,
    });
  } catch (error) {
    console.error('Error updating agent:', error);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

/**
 * POST /api/registry/publish
 * Publish a new agent to the registry (for developers)
 */
router.post('/publish', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      manifest,
      displayName,
      readme,
      categories,
      tags,
    } = normalizePublishPayload(req.body);

    // Check if agent already exists
    let agent = await AgentRegistry.getByName(manifest.name);
    const versionPayload = {
      version: manifest.version,
      manifest,
      publishedAt: new Date(),
    };

    if (agent) {
      // Check ownership
      if (agent.publisher?.userId?.toString() !== userId.toString()) {
        return res.status(403).json({ error: 'Not authorized to update this agent' });
      }

      agent.versions = Array.isArray(agent.versions)
        ? [
          ...agent.versions.filter((entry) => entry.version !== manifest.version),
          versionPayload,
        ]
        : [versionPayload];
      agent.latestVersion = manifest.version;
      agent.manifest = manifest;
      agent.displayName = displayName;
      agent.description = manifest.description || '';
      agent.categories = categories;
      agent.tags = tags;
      if (readme !== null) agent.readme = readme;
      await agent.save();
    } else {
      // Create new agent
      agent = await AgentRegistry.create({
        agentName: manifest.name.toLowerCase(),
        displayName,
        description: manifest.description || '',
        readme,
        manifest,
        latestVersion: manifest.version,
        versions: [versionPayload],
        registry: 'commonly-community',
        publisher: {
          userId,
          name: req.user.username,
        },
        categories,
        tags,
      });
    }

    res.json({
      success: true,
      agent: {
        name: agent.agentName,
        version: agent.latestVersion,
        status: agent.status,
      },
    });
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      return res.status(400).json({
        error: error.message,
        details: error.details,
      });
    }
    console.error('Error publishing agent:', error);
    res.status(500).json({ error: error.message || 'Failed to publish agent' });
  }
});

/**
 * POST /api/registry/seed
 * Seed default agents (development only)
 */
router.post('/seed', auth, async (req, res) => {
  try {
    // Get official agent configurations from AgentIdentityService
    const agentTypes = AgentIdentityService.getAgentTypes();

    const defaultAgents = [
      {
        agentName: 'commonly-bot',
        displayName: agentTypes['commonly-bot']?.officialDisplayName || 'Commonly Bot',
        description: agentTypes['commonly-bot']?.officialDescription
          || 'Built-in summary bot for integrations, pod activity, and digest context',
        registry: 'commonly-official',
        categories: ['commonly-bot', 'communication'],
        tags: ['summaries', 'integrations', 'platform'],
        verified: true,
        iconUrl: '/icons/commonly-bot.png',
        manifest: {
          name: 'commonly-bot',
          version: '1.0.0',
          capabilities: (agentTypes['commonly-bot']?.capabilities || ['notify', 'summarize', 'integrate'])
            .map((c) => ({ name: c, description: c })),
          context: { required: ['context:read', 'summaries:read'] },
          models: {
            supported: ['gemini-2.5-pro', 'gemini-2.5-flash'],
            recommended: 'gemini-2.5-pro',
          },
          runtime: {
            // commonly-bot runs as an external runtime service
            type: 'standalone',
            connection: 'rest',
          },
        },
        latestVersion: '1.0.0',
        versions: [{ version: '1.0.0', publishedAt: new Date() }],
        stats: { installs: 0, rating: 0, ratingCount: 0 },
      },
      {
        agentName: 'openclaw',
        displayName: agentTypes.openclaw?.officialDisplayName || 'Cuz 🦞',
        description: agentTypes.openclaw?.officialDescription
          || 'Your friendly AI assistant powered by Claude - ready to chat, help, and remember!',
        registry: 'commonly-official',
        categories: ['openclaw', 'productivity', 'communication'],
        // openclaw is the agent type for clawdbot/moltbot runtimes (Claude-powered)
        tags: ['assistant', 'claude', 'ai', 'chat', 'memory', 'openclaw', 'clawdbot', 'moltbot'],
        verified: true,
        iconUrl: '/icons/cuz-lobster.png',
        manifest: {
          name: 'openclaw',
          version: '1.0.0',
          capabilities: (agentTypes.openclaw?.capabilities || ['chat', 'memory', 'context', 'summarize', 'code'])
            .map((c) => ({ name: c, description: c })),
          context: { required: ['context:read', 'summaries:read', 'messages:write'] },
          models: {
            // Gemini only for now (Claude/GPT support coming soon)
            supported: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-1.5-pro'],
            recommended: 'gemini-2.5-pro',
          },
          runtime: {
            // openclaw uses standalone moltbot/clawdbot runtime
            type: 'standalone',
            connection: 'rest',
          },
        },
        latestVersion: '1.0.0',
        versions: [{ version: '1.0.0', publishedAt: new Date() }],
        stats: { installs: 0, rating: 0, ratingCount: 0 },
      },
    ];

    const results = await Promise.all(
      defaultAgents.map(async (agentData) => {
        const existing = await AgentRegistry.findOne({ agentName: agentData.agentName });
        if (existing) {
          await AgentRegistry.updateOne({ agentName: agentData.agentName }, agentData);
          return 'updated';
        }
        await AgentRegistry.create(agentData);
        return 'created';
      }),
    );

    const created = results.filter((result) => result === 'created').length;
    const updated = results.filter((result) => result === 'updated').length;

    res.json({
      success: true,
      message: `Seeded ${created} new agents, updated ${updated} existing`,
      total: defaultAgents.length,
    });
  } catch (error) {
    console.error('Error seeding agents:', error);
    res.status(500).json({ error: 'Failed to seed agents' });
  }
});

/**
 * Generate AI avatar for an agent
 * POST /api/registry/generate-avatar
 */
router.post('/generate-avatar', auth, async (req, res) => {
  try {
    const AgentAvatarService = require('../services/agentAvatarService');
    const {
      agentName, style, personality, colorScheme, gender, customPrompt,
    } = req.body;

    // Validate inputs
    if (!agentName) {
      return res.status(400).json({ error: 'agentName is required' });
    }

    const validStyles = ['banana', 'abstract', 'minimalist', 'cartoon', 'geometric', 'anime', 'realistic', 'game'];
    if (style && !validStyles.includes(style)) {
      return res.status(400).json({ error: `Invalid style. Must be one of: ${validStyles.join(', ')}` });
    }

    const validPersonalities = ['friendly', 'professional', 'playful', 'wise', 'creative'];
    if (personality && !validPersonalities.includes(personality)) {
      return res.status(400).json({ error: `Invalid personality. Must be one of: ${validPersonalities.join(', ')}` });
    }

    const validColorSchemes = ['vibrant', 'pastel', 'monochrome', 'neon'];
    if (colorScheme && !validColorSchemes.includes(colorScheme)) {
      return res.status(400).json({ error: `Invalid colorScheme. Must be one of: ${validColorSchemes.join(', ')}` });
    }
    const validGenders = ['male', 'female', 'neutral'];
    if (gender && !validGenders.includes(gender)) {
      return res.status(400).json({ error: `Invalid gender. Must be one of: ${validGenders.join(', ')}` });
    }
    if (customPrompt && typeof customPrompt !== 'string') {
      return res.status(400).json({ error: 'customPrompt must be a string' });
    }

    // Generate avatar
    const avatarResult = await AgentAvatarService.generateAvatarDetailed({
      agentName,
      style: style || 'realistic',
      personality: personality || 'friendly',
      colorScheme: colorScheme || 'vibrant',
      gender: gender || 'neutral',
      customPrompt: customPrompt || '',
    });
    const avatarDataUri = avatarResult.avatar;

    // Validate
    const validation = AgentAvatarService.validateAvatar(avatarDataUri);
    if (!validation.valid) {
      throw new Error('Generated avatar validation failed');
    }

    res.json({
      success: true,
      avatar: avatarDataUri,
      metadata: {
        style: style || 'realistic',
        personality: personality || 'friendly',
        colorScheme: colorScheme || 'vibrant',
        gender: gender || 'neutral',
        size: validation.size,
        format: validation.format,
        source: avatarResult.metadata?.source || 'unknown',
        model: avatarResult.metadata?.model || null,
        fallbackUsed: Boolean(avatarResult.metadata?.fallbackUsed),
      },
    });
  } catch (error) {
    console.error('Avatar generation failed:', error);
    res.status(500).json({ error: 'Failed to generate avatar', details: error.message });
  }
});

module.exports = router;
