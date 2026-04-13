// Agent install route — extracted from registry.js (GH#112)
// Handles: POST /install
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const Activity = require('../../models/Activity');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentIdentityService = require('../../services/agentIdentityService');
const AgentMessageService = require('../../services/agentMessageService');
const {
  getUserId,
  normalizeInstanceId,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
  sanitizeRuntimeConfig,
  resolveGatewayForRequest,
  buildAgentProfileId,
} = require('./helpers');
const {
  AUTO_GRANTED_INTEGRATION_SCOPES,
} = require('./tokens');

const installRouter = express.Router();

/**
 * Derive instanceId from displayName for consistent agent identity across pods.
 * This ensures the same agent (e.g., "Cuz") gets the same instanceId regardless
 * of which pod it's installed in, allowing shared runtime tokens and memory.
 */
const deriveInstanceId = (displayName: any, agentName: any) => {
  if (!displayName) return 'default';
  const slug = String(displayName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug === agentName.toLowerCase()) {
    return 'default';
  }
  return slug;
};

/**
 * Check if an agent instance already exists globally (across all pods).
 * Returns the existing installations and agent user if found.
 */
const findExistingAgentInstance = async (agentName: any, instanceId: any) => {
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

/**
 * POST /api/registry/install
 * Install an agent to a pod
 */
installRouter.post('/install', auth, async (req: any, res: any) => {
  try {
    const {
      agentName, podId, version, config = {}, scopes = [], instanceId, displayName, gatewayId,
    } = req.body;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const agent = await AgentRegistry.getByName(agentName);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found in registry' });
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
      return res.status(403).json({ error: 'You must be a member of this pod' });
    }

    let normalizedInstanceId;
    if (instanceId) {
      normalizedInstanceId = normalizeInstanceId(instanceId);
      if (normalizedInstanceId === agentName.toLowerCase()) {
        normalizedInstanceId = 'default';
      }
    } else {
      normalizedInstanceId = deriveInstanceId(displayName, agentName);
    }

    const existingInPod = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      podId,
      instanceId: normalizedInstanceId,
      status: 'active',
    });

    if (existingInPod) {
      return res.status(400).json({ error: 'Agent already installed in this pod' });
    }

    const globalAgent = await findExistingAgentInstance(agentName, normalizedInstanceId);
    const isReusingExistingAgent = globalAgent.exists;

    const requiredScopes = agent.manifest.context?.required || [];
    const missingScopes = requiredScopes.filter((s: any) => !scopes.includes(s));
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

    const installation = await AgentInstallation.install(agentName, podId, {
      version: version || agent.latestVersion,
      config: installConfig,
      scopes: grantedScopes,
      installedBy: userId,
      instanceId: normalizedInstanceId,
      displayName: displayName || agent.displayName,
    });

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
        specialties: agent.manifest.capabilities?.map((c: any) => c.name) || [],
      },
      toolPolicy: {
        allowed: grantedScopes.filter((s: any) => s.includes(':')).map((s: any) => s.split(':')[0]),
      },
      createdBy: userId,
    });

    try {
      const agentUser = await AgentIdentityService.getOrCreateAgentUser(agent.agentName, {
        instanceId: normalizedInstanceId,
        displayName: displayName || agent.displayName,
      });
      await AgentIdentityService.ensureAgentInPod(agentUser, podId);
    } catch (identityError: unknown) {
      console.warn('Failed to provision agent user identity:', (identityError as Error).message);
    }

    await AgentRegistry.incrementInstalls(agentName);

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
    } catch (activityError: unknown) {
      console.warn('Failed to create activity for agent install:', (activityError as Error).message);
    }

    // Post a short self-introduction so the room learns the new member
    // without having to wait for their first heartbeat. Team pods only —
    // skip DMs, agent-rooms, and single-member surfaces.
    try {
      const podDoc = await Pod.findById(podId).select('type members').lean();
      const introWorthy = podDoc
        && podDoc.type !== 'dm'
        && podDoc.type !== 'agent-room'
        && (podDoc.members?.length || 0) >= 2;
      if (introWorthy) {
        const displayName = installation.displayName || agent.displayName;
        const blurb = (agent.description || '').trim().replace(/\s+/g, ' ');
        const intro = blurb
          ? `Hi all — I'm ${displayName}. ${blurb} Ping me when you need it.`
          : `Hi all — I'm ${displayName}, just joined the pod.`;
        await AgentMessageService.postMessage({
          agentName: agent.agentName,
          instanceId: normalizedInstanceId,
          displayName,
          podId,
          content: intro,
          metadata: { kind: 'install-intro' },
        });
      }
    } catch (introError: unknown) {
      console.warn('Failed to post install intro:', (introError as Error).message);
    }

    const otherPodIds = isReusingExistingAgent
      ? globalAgent.installations
        .filter((i: any) => i.podId.toString() !== podId)
        .map((i: any) => i.podId)
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
      sharedIdentity: isReusingExistingAgent,
      otherPods: otherPodIds,
      hasExistingRuntimeToken: globalAgent.agentUser?.agentRuntimeTokens?.length > 0,
    });
  } catch (error) {
    console.error('Error installing agent:', error);
    res.status(500).json({ error: (error as any).message || 'Failed to install agent' });
  }
});

module.exports = installRouter;

export {};
