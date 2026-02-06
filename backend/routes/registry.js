/**
 * Agent Registry Routes
 *
 * API for the agent "package manager" - discover, install, configure agents.
 */

const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');
const AgentProfile = require('../models/AgentProfile');
const Activity = require('../models/Activity');
const Pod = require('../models/Pod');
const User = require('../models/User');
const Gateway = require('../models/Gateway');
const AgentTemplate = require('../models/AgentTemplate');
const AgentIdentityService = require('../services/agentIdentityService');
const { generateText } = require('../services/llmService');
const {
  provisionAgentRuntime,
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
  isK8sMode,
  restartDockerRuntime,
  listOpenClawPlugins,
  installOpenClawPlugin,
  writeOpenClawHeartbeatFile,
  syncOpenClawSkills,
} = require('../services/agentProvisionerService');
const { hash, randomSecret } = require('../utils/secret');

const parseVerifiedFilter = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getUserId = (req) => req.userId || req.user?.id || req.user?._id;

const normalizeConfigMap = (config) => {
  if (!config) return null;
  if (config instanceof Map) {
    return Object.fromEntries(config.entries());
  }
  if (typeof config === 'object') {
    return config;
  }
  return null;
};

const normalizeRuntimeAuthProfiles = (profiles) => {
  if (!profiles || typeof profiles !== 'object') return null;
  const normalized = {};
  Object.entries(profiles).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const provider = String(value.provider || '').trim().toLowerCase();
    const rawKey = String(value.key || '').trim();
    if (!provider || !rawKey) return;
    const type = String(value.type || 'api_key').trim().toLowerCase();
    if (type !== 'api_key') return;
    const profileId = String(key || `${provider}:default`).trim();
    normalized[profileId || `${provider}:default`] = {
      type: 'api_key',
      provider,
      key: rawKey,
    };
  });
  return Object.keys(normalized).length ? normalized : null;
};

const normalizeSkillEnvEntries = (entries) => {
  if (!entries || typeof entries !== 'object') return null;
  const normalized = {};
  Object.entries(entries).forEach(([skillName, value]) => {
    const name = String(skillName || '').trim();
    if (!name || !value || typeof value !== 'object') return;
    const env = value.env && typeof value.env === 'object' ? value.env : {};
    const envEntries = Object.entries(env)
      .map(([key, val]) => [String(key || '').trim(), String(val ?? '').trim()])
      .filter(([key, val]) => key && val);
    const apiKey = String(value.apiKey ?? '').trim();
    if (!envEntries.length && !apiKey) return;
    normalized[name] = {
      ...(envEntries.length ? { env: Object.fromEntries(envEntries) } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  });
  return Object.keys(normalized).length ? normalized : null;
};

const sanitizeRuntimeConfig = (runtimeConfig) => {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') return runtimeConfig;
  const { authProfiles, skillEnv, ...rest } = runtimeConfig;
  const providers = authProfiles && typeof authProfiles === 'object'
    ? Array.from(new Set(
      Object.values(authProfiles)
        .map((profile) => String(profile?.provider || '').trim().toLowerCase())
        .filter(Boolean),
    ))
    : [];
  const skillKeys = skillEnv && typeof skillEnv === 'object'
    ? Object.keys(skillEnv).map((key) => String(key || '').trim()).filter(Boolean)
    : [];
  return {
    ...rest,
    authProviders: providers,
    hasCustomAuthProfiles: providers.length > 0,
    hasCustomSkillEnv: skillKeys.length > 0,
    skillEnvKeys: skillKeys,
  };
};

const normalizePluginIdentifier = (value) => String(value || '').trim().toLowerCase();

const getPluginSpecBase = (spec) => {
  const normalized = normalizePluginIdentifier(spec);
  if (!normalized) return '';
  if (normalized.startsWith('@')) {
    const parts = normalized.split('@');
    if (parts.length >= 2 && parts[1]) {
      return `@${parts[1]}`;
    }
    return normalized;
  }
  return normalized.split('@')[0];
};

const normalizeInstanceId = (raw) => {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'default';
};

const buildRuntimeLogFilters = ({ runtimeType, agentName, instanceId }) => {
  if (runtimeType !== 'moltbot') return [];
  const normalizedInstance = normalizeInstanceId(instanceId);
  const normalizedAgent = String(agentName || '').trim().toLowerCase();
  const accountId = normalizedAgent === 'openclaw'
    ? normalizedInstance
    : `${normalizedAgent}-${normalizedInstance}`;
  const tokens = [normalizedInstance, accountId, normalizedAgent].filter(Boolean);
  return Array.from(new Set(tokens));
};

const resolveGatewayForRequest = async ({ gatewayId, userId }) => {
  if (!gatewayId) return null;
  const user = await User.findById(userId).select('role').lean();
  if (!user || user.role !== 'admin') {
    const error = new Error('Global admin required to select a gateway');
    error.status = 403;
    throw error;
  }
  const gateway = await Gateway.findById(gatewayId).lean();
  if (!gateway) {
    const error = new Error('Gateway not found');
    error.status = 404;
    throw error;
  }
  if (gateway.status && gateway.status !== 'active') {
    const error = new Error('Gateway is not active');
    error.status = 400;
    throw error;
  }
  if (isK8sMode() && gateway.mode !== 'k8s') {
    const error = new Error('Gateway must be K8s mode in this environment');
    error.status = 400;
    throw error;
  }
  return gateway;
};

const isGlobalAdminUser = async (userId) => {
  const user = await User.findById(userId).select('role').lean();
  return Boolean(user && user.role === 'admin');
};

const resolveGatewayForInstallation = async ({ gatewayId }) => {
  if (!gatewayId) return null;
  const gateway = await Gateway.findById(gatewayId).lean();
  if (!gateway) {
    const error = new Error('Gateway not found');
    error.status = 404;
    throw error;
  }
  if (gateway.status && gateway.status !== 'active') {
    const error = new Error('Gateway is not active');
    error.status = 400;
    throw error;
  }
  if (isK8sMode() && gateway.mode !== 'k8s') {
    const error = new Error('Gateway must be K8s mode in this environment');
    error.status = 400;
    throw error;
  }
  return gateway;
};

const userHasPodAccess = (pod, userId) => {
  if (!pod || !userId) return false;
  const userIdStr = userId.toString();
  if (pod.createdBy?.toString() === userIdStr) return true;
  return Boolean(pod.members?.some((m) => (m.userId?.toString?.() || m.toString()) === userIdStr));
};

const parseJsonFromText = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
};

const serializeRuntimeTokens = (tokens = []) => tokens.map((token) => ({
  id: token._id?.toString(),
  label: token.label,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
}));

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

const AGENT_USER_TOKEN_SCOPES = new Set([
  'agent:events:read',
  'agent:events:ack',
  'agent:context:read',
  'agent:messages:read',
  'agent:messages:write',
]);

const normalizeScopes = (scopes) => {
  if (!Array.isArray(scopes)) return [];
  return Array.from(new Set(scopes.filter((scope) => AGENT_USER_TOKEN_SCOPES.has(scope))));
};

const AUTO_GRANTED_INTEGRATION_SCOPES = [
  'integration:read',
  'integration:messages:read',
];

const sanitizeStringList = (value) => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean)));
};

const normalizeToolPolicy = (policy) => {
  if (!policy || typeof policy !== 'object') return null;
  return {
    allowed: sanitizeStringList(policy.allowed),
    blocked: sanitizeStringList(policy.blocked),
    requireApproval: sanitizeStringList(policy.requireApproval),
  };
};

const normalizeContextPolicy = (policy) => {
  if (!policy || typeof policy !== 'object') return null;
  const next = { ...policy };
  if (next.maxTokens !== undefined) next.maxTokens = Number(next.maxTokens);
  if (next.compactionThreshold !== undefined) next.compactionThreshold = Number(next.compactionThreshold);
  if (next.summaryHours !== undefined) next.summaryHours = Number(next.summaryHours);
  return next;
};

/**
 * Issue a runtime token for an agent.
 * Tokens are stored on the User model (shared across all pod installations).
 * This ensures the same agent identity uses the same token regardless of which pod.
 *
 * @param {Object} agentUser - The agent's User document
 * @param {string} label - Token label
 * @param {Object} installation - Optional installation to also store token on (for backward compat)
 * @returns {Object} - { token, label, existing, createdAt }
 */
const issueRuntimeTokenForAgent = async (agentUser, label, installation = null) => {
  // Check if agent already has a runtime token (reuse existing)
  if (agentUser.agentRuntimeTokens?.length > 0) {
    const existingToken = agentUser.agentRuntimeTokens[0];
    return {
      existing: true,
      label: existingToken.label,
      createdAt: existingToken.createdAt,
      // Can't return raw token for existing - it's hashed
      message: 'Agent already has a runtime token. Use existing token or revoke to generate new.',
    };
  }

  // Generate new token
  const rawToken = `cm_agent_${randomSecret(32)}`;
  const tokenRecord = {
    tokenHash: hash(rawToken),
    label: label || 'Runtime token',
    createdAt: new Date(),
  };

  // Store on User model (primary - shared across pods)
  agentUser.agentRuntimeTokens = agentUser.agentRuntimeTokens || [];
  agentUser.agentRuntimeTokens.push(tokenRecord);
  await agentUser.save();

  // Also store on installation for backward compatibility
  if (installation) {
    installation.runtimeTokens = installation.runtimeTokens || [];
    installation.runtimeTokens.push(tokenRecord);
    await installation.save();
  }

  return {
    token: rawToken,
    label: label || 'Runtime token',
    existing: false,
    createdAt: tokenRecord.createdAt,
  };
};

/**
 * Legacy function for backward compatibility.
 * @deprecated Use issueRuntimeTokenForAgent instead
 */
const issueRuntimeTokenForInstallation = async (installation, label) => {
  const rawToken = `cm_agent_${randomSecret(32)}`;
  installation.runtimeTokens = installation.runtimeTokens || [];
  installation.runtimeTokens.push({
    tokenHash: hash(rawToken),
    label: label || 'Runtime token',
    createdAt: new Date(),
  });
  await installation.save();
  return { token: rawToken, label: label || 'Runtime token' };
};

const issueUserTokenForInstallation = async ({
  agentName,
  instanceId,
  displayName,
  podId,
  scopes,
}) => {
  const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName.toLowerCase(), {
    instanceId,
    displayName,
  });
  await AgentIdentityService.ensureAgentInPod(agentUser, podId);
  const normalizedScopes = normalizeScopes(scopes);
  const token = agentUser.generateApiToken();
  agentUser.apiTokenScopes = normalizedScopes;
  await agentUser.save();
  return { token, scopes: normalizedScopes, createdAt: agentUser.apiTokenCreatedAt };
};

/**
 * GET /api/registry/templates
 * List agent templates (public + creator's private)
 */
router.get('/templates', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const templates = await AgentTemplate.find({
      $or: [
        { visibility: 'public' },
        { visibility: 'private', createdBy: userId },
      ],
    }).lean();

    return res.json({
      templates: templates.map((template) => ({
        id: template._id.toString(),
        agentName: template.agentName,
        displayName: template.displayName,
        description: template.description,
        iconUrl: template.iconUrl,
        visibility: template.visibility,
        createdBy: template.createdBy?.toString?.() || template.createdBy,
      })),
    });
  } catch (error) {
    console.error('Error listing agent templates:', error);
    return res.status(500).json({ error: 'Failed to list agent templates' });
  }
});

/**
 * POST /api/registry/templates
 * Create a new agent template (public or private)
 */
router.post('/templates', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      agentName,
      displayName,
      description = '',
      iconUrl = '',
      visibility = 'private',
    } = req.body || {};

    if (!agentName || !displayName) {
      return res.status(400).json({ error: 'agentName and displayName are required' });
    }

    const trimmedDisplayName = displayName.trim();
    if (!trimmedDisplayName) {
      return res.status(400).json({ error: 'displayName is required' });
    }

    const agent = await AgentRegistry.getByName(agentName);
    if (!agent) {
      return res.status(404).json({ error: 'Agent type not found' });
    }

    if (!['private', 'public'].includes(visibility)) {
      return res.status(400).json({ error: 'Invalid visibility' });
    }

    const existingTemplate = await AgentTemplate.findOne({
      createdBy: userId,
      displayName: { $regex: `^${escapeRegExp(trimmedDisplayName)}$`, $options: 'i' },
    }).select('_id').lean();
    if (existingTemplate) {
      return res.status(400).json({ error: 'Agent name already exists' });
    }

    const template = await AgentTemplate.create({
      agentName: agentName.toLowerCase(),
      displayName: trimmedDisplayName,
      description,
      iconUrl,
      visibility,
      createdBy: userId,
    });

    return res.json({
      success: true,
      template: {
        id: template._id.toString(),
        agentName: template.agentName,
        displayName: template.displayName,
        description: template.description,
        iconUrl: template.iconUrl,
        visibility: template.visibility,
      },
    });
  } catch (error) {
    console.error('Error creating agent template:', error);
    return res.status(500).json({ error: 'Failed to create agent template' });
  }
});

/**
 * PATCH /api/registry/templates/:id
 * Update an existing agent template (creator only)
 */
router.patch('/templates/:id', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const template = await AgentTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (template.createdBy?.toString?.() !== userId.toString()) {
      return res.status(403).json({ error: 'Not authorized to update this template' });
    }

    const {
      displayName,
      description,
      visibility,
      iconUrl,
    } = req.body || {};

    if (displayName !== undefined) {
      const trimmed = String(displayName).trim();
      if (!trimmed) {
        return res.status(400).json({ error: 'displayName is required' });
      }
      template.displayName = trimmed;
    }

    if (description !== undefined) {
      template.description = description;
    }

    if (visibility !== undefined) {
      if (!['private', 'public'].includes(visibility)) {
        return res.status(400).json({ error: 'Invalid visibility' });
      }
      template.visibility = visibility;
    }

    if (iconUrl !== undefined) {
      template.iconUrl = iconUrl || '';
    }

    await template.save();

    return res.json({
      success: true,
      template: {
        id: template._id.toString(),
        agentName: template.agentName,
        displayName: template.displayName,
        description: template.description,
        iconUrl: template.iconUrl,
        visibility: template.visibility,
      },
    });
  } catch (error) {
    console.error('Error updating agent template:', error);
    return res.status(500).json({ error: 'Failed to update agent template' });
  }
});

/**
 * DELETE /api/registry/templates/:id
 * Remove an agent template (creator only)
 */
router.delete('/templates/:id', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const template = await AgentTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (template.createdBy?.toString?.() !== userId.toString()) {
      return res.status(403).json({ error: 'Not authorized to delete this template' });
    }

    await AgentTemplate.deleteOne({ _id: template._id });

    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting agent template:', error);
    return res.status(500).json({ error: 'Failed to delete agent template' });
  }
});

/**
 * GET /api/registry/agents
 * List available agents in the registry
 */
router.get('/agents', auth, async (req, res) => {
  try {
    const {
      q, category, verified, registry, limit = 20, offset = 0,
    } = req.query;

    const agents = await AgentRegistry.search(q, {
      category,
      verified: parseVerifiedFilter(verified),
      registry: registry || null,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    res.json({
      agents: agents.map((a) => ({
        name: a.agentName,
        displayName: a.displayName,
        description: a.description,
        version: a.latestVersion,
        verified: a.verified,
        categories: a.categories,
        stats: a.stats,
        iconUrl: a.iconUrl,
      })),
      total: agents.length,
    });
  } catch (error) {
    console.error('Error listing agents:', error);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

/**
 * GET /api/registry/agents/:name
 * Get agent details
 */
router.get('/agents/:name', auth, async (req, res) => {
  try {
    const agent = await AgentRegistry.getByName(req.params.name);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      name: agent.agentName,
      displayName: agent.displayName,
      description: agent.description,
      readme: agent.readme,
      version: agent.latestVersion,
      versions: agent.versions.map((v) => ({
        version: v.version,
        publishedAt: v.publishedAt,
        deprecated: v.deprecated,
      })),
      manifest: agent.manifest,
      verified: agent.verified,
      publisher: agent.publisher,
      categories: agent.categories,
      tags: agent.tags,
      stats: agent.stats,
      iconUrl: agent.iconUrl,
    });
  } catch (error) {
    console.error('Error getting agent:', error);
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

/**
 * GET /api/registry/agents/:name/instances/:instanceId
 * Check if an agent instance exists globally (across all pods).
 * Used by UI to detect if installing to a new pod should reuse existing identity.
 */
router.get('/agents/:name/instances/:instanceId', auth, async (req, res) => {
  try {
    const { name, instanceId } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const normalizedInstanceId = normalizeInstanceId(instanceId);
    const globalAgent = await findExistingAgentInstance(name, normalizedInstanceId);

    if (!globalAgent.exists) {
      return res.json({ exists: false });
    }

    // Get pod names for UI display
    const podIds = globalAgent.installations.map((i) => i.podId);
    const pods = await Pod.find({ _id: { $in: podIds } }).select('name').lean();
    const podMap = new Map(pods.map((p) => [p._id.toString(), p.name]));

    return res.json({
      exists: true,
      installations: globalAgent.installations.map((i) => ({
        podId: i.podId.toString(),
        podName: podMap.get(i.podId.toString()) || 'Unknown Pod',
        displayName: i.displayName,
        instanceId: i.instanceId,
        provisionedAt: i.config?.runtime?.provisionedAt || null,
      })),
      hasRuntimeToken: (globalAgent.agentUser?.agentRuntimeTokens?.length || 0) > 0,
      agentUsername: globalAgent.agentUser?.username || null,
    });
  } catch (error) {
    console.error('Error checking agent instance:', error);
    return res.status(500).json({ error: 'Failed to check agent instance' });
  }
});

/**
 * GET /api/registry/agents/:name/instances
 * List all instances of an agent type (for discovery).
 */
router.get('/agents/:name/instances', auth, async (req, res) => {
  try {
    const { name } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Find all active installations of this agent type
    const installations = await AgentInstallation.find({
      agentName: name.toLowerCase(),
      status: 'active',
    }).lean();

    // Group by instanceId
    const instanceMap = new Map();
    installations.forEach((i) => {
      const key = i.instanceId || 'default';
      if (!instanceMap.has(key)) {
        instanceMap.set(key, {
          instanceId: key,
          displayName: i.displayName,
          pods: [],
        });
      }
      instanceMap.get(key).pods.push(i.podId.toString());
    });

    // Get pod names
    const allPodIds = installations.map((i) => i.podId);
    const pods = await Pod.find({ _id: { $in: allPodIds } }).select('name').lean();
    const podMap = new Map(pods.map((p) => [p._id.toString(), p.name]));

    const instances = Array.from(instanceMap.values()).map((inst) => ({
      ...inst,
      pods: inst.pods.map((podId) => ({
        podId,
        podName: podMap.get(podId) || 'Unknown Pod',
      })),
    }));

    return res.json({ instances });
  } catch (error) {
    console.error('Error listing agent instances:', error);
    return res.status(500).json({ error: 'Failed to list agent instances' });
  }
});

/**
 * GET /api/registry/categories
 * List agent categories
 */
router.get('/categories', auth, async (req, res) => {
  try {
    const categories = await AgentRegistry.distinct('categories');
    res.json({ categories });
  } catch (error) {
    console.error('Error listing categories:', error);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

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
 * DELETE /api/registry/agents/:name/pods/:podId
 * Uninstall an agent from a pod
 */
router.delete('/agents/:name/pods/:podId', auth, async (req, res) => {
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

    // Verify user has admin access to pod
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

    if (!installation) {
      if (!isCreator) {
        return res.status(404).json({ error: 'Agent not installed in this pod' });
      }

      await AgentProfile.deleteOne({ agentId: buildAgentProfileId(name, instanceId), podId });
      try {
        const resolvedType = AgentIdentityService.resolveAgentType(name);
        await AgentIdentityService.removeAgentFromPod(
          AgentIdentityService.buildAgentUsername(resolvedType, instanceId),
          podId,
        );
      } catch (identityError) {
        console.warn('Failed to remove agent user from pod:', identityError.message);
      }

      return res.json({ success: true, removedOrphan: true });
    }

    const isInstaller = installation.installedBy?.toString?.() === userId.toString();

    if (!isCreator && !isInstaller) {
      return res.status(403).json({ error: 'Only pod admins or installers can remove agents' });
    }

    // Uninstall
    await AgentInstallation.uninstall(name, podId, instanceId);

    // Remove agent profile
    await AgentProfile.deleteOne({ agentId: buildAgentProfileId(name, instanceId), podId });

    try {
      const resolvedType = AgentIdentityService.resolveAgentType(name);
      await AgentIdentityService.removeAgentFromPod(
        AgentIdentityService.buildAgentUsername(resolvedType, instanceId),
        podId,
      );
    } catch (identityError) {
      console.warn('Failed to remove agent user from pod:', identityError.message);
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
router.get('/pods/:podId/agents', auth, async (req, res) => {
  try {
    const { podId } = req.params;
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

    // Get installations
    const installations = await AgentInstallation.getInstalledAgents(podId);
    const registryEntries = await AgentRegistry.find({
      agentName: { $in: installations.map((i) => i.agentName) },
    }).select('agentName iconUrl').lean();
    const iconMap = new Map(registryEntries.map((entry) => [entry.agentName, entry.iconUrl || '']));

    // Get agent profiles for more details
    const profiles = await AgentProfile.find({
      podId,
      agentName: { $in: installations.map((i) => i.agentName) },
    }).lean();

    res.json({
      agents: installations.map((i) => {
        const profile = profiles.find(
          (p) => p.agentName === i.agentName && p.instanceId === (i.instanceId || 'default'),
        );
        const normalizedConfig = normalizeConfigMap(i.config);
        const runtimeConfig = sanitizeRuntimeConfig(normalizedConfig?.runtime || i.config?.runtime || null);
        return {
          name: i.agentName,
          instanceId: i.instanceId || 'default',
          displayName: i.displayName,
          iconUrl: iconMap.get(i.agentName) || '',
          version: i.version,
          status: i.status,
          scopes: i.scopes,
          installedAt: i.createdAt,
          usage: i.usage,
          installedBy: i.installedBy?.toString?.() || i.installedBy,
          runtime: runtimeConfig,
          config: normalizedConfig ? {
            heartbeat: normalizedConfig.heartbeat || null,
            skillSync: normalizedConfig.skillSync || null,
          } : null,
          profile: profile
            ? {
              displayName: profile.name,
              purpose: profile.purpose,
              isDefault: profile.isDefault,
              modelPreferences: profile.modelPreferences,
              instructions: profile.instructions,
              persona: profile.persona,
              toolPolicy: profile.toolPolicy,
              contextPolicy: profile.contextPolicy,
            }
            : null,
        };
      }),
    });
  } catch (error) {
    console.error('Error listing pod agents:', error);
    res.status(500).json({ error: 'Failed to list pod agents' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-tokens
 * List runtime tokens for an installed agent
 */
router.get('/pods/:podId/agents/:name/runtime-tokens', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { installation, instanceId } = await resolveInstallation({
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
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const tokens = (installation.runtimeTokens || []).map((token) => ({
      id: token._id?.toString(),
      label: token.label,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
    }));

    return res.json({ tokens });
  } catch (error) {
    console.error('Error listing agent runtime tokens:', error);
    return res.status(500).json({ error: 'Failed to list runtime tokens' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-tokens
 * Issue a runtime token for an installed agent
 */
router.post('/pods/:podId/agents/:name/runtime-tokens', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { label, instanceId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
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
    const normalizedInstanceId = resolved.instanceId;

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const issued = await issueRuntimeTokenForInstallation(installation, label);
    return res.json(issued);
  } catch (error) {
    console.error('Error issuing agent runtime token:', error);
    return res.status(500).json({ error: 'Failed to issue runtime token' });
  }
});

/**
 * DELETE /api/registry/pods/:podId/agents/:name/runtime-tokens/:tokenId
 * Revoke a runtime token for an installed agent
 */
router.delete('/pods/:podId/agents/:name/runtime-tokens/:tokenId', auth, async (req, res) => {
  try {
    const { podId, name, tokenId } = req.params;
    const { installation, instanceId } = await resolveInstallation({
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
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const originalCount = installation.runtimeTokens?.length || 0;
    installation.runtimeTokens = (installation.runtimeTokens || []).filter(
      (token) => token._id?.toString() !== tokenId,
    );

    if ((installation.runtimeTokens || []).length === originalCount) {
      return res.status(404).json({ error: 'Runtime token not found' });
    }

    await installation.save();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error revoking agent runtime token:', error);
    return res.status(500).json({ error: 'Failed to revoke runtime token' });
  }
});

/**
 * GET /api/registry/admin/installations
 * List agent installations across all pods (admin only)
 */
router.get('/admin/installations', auth, adminAuth, async (req, res) => {
  try {
    const {
      q,
      status = 'active',
      limit: limitParam,
      offset: offsetParam,
    } = req.query || {};

    const limit = Math.min(Math.max(parseInt(limitParam, 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(offsetParam, 10) || 0, 0);

    const filter = {};
    if (status && status !== 'all') {
      filter.status = status;
    }

    if (q) {
      const regex = new RegExp(escapeRegExp(String(q).trim()), 'i');
      const matchedPods = await Pod.find({ name: regex }).select('_id').lean();
      const matchedPodIds = matchedPods.map((pod) => pod._id);
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

    const podIds = installations.map((install) => install.podId).filter(Boolean);
    const pods = await Pod.find({ _id: { $in: podIds } })
      .select('_id name createdBy')
      .lean();
    const podMap = new Map(pods.map((pod) => [pod._id.toString(), pod]));

    const userIds = new Set();
    installations.forEach((install) => {
      if (install.installedBy) userIds.add(install.installedBy.toString());
    });
    pods.forEach((pod) => {
      if (pod.createdBy) userIds.add(pod.createdBy.toString());
    });

    const users = userIds.size
      ? await User.find({ _id: { $in: Array.from(userIds) } })
        .select('_id username email role')
        .lean()
      : [];
    const userMap = new Map(users.map((user) => [user._id.toString(), user]));

    const payload = installations.map((install) => {
      const pod = podMap.get(install.podId?.toString?.() || '');
      const installedBy = install.installedBy
        ? userMap.get(install.installedBy.toString())
        : null;
      const podOwner = pod?.createdBy
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

// GET /api/registry/agents/:name/installations?instanceId=
router.get('/agents/:name/installations', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const agentName = String(req.params.name || '').toLowerCase();
    const instanceId = normalizeInstanceId(req.query.instanceId);
    const installations = await AgentInstallation.find({
      agentName,
      instanceId,
      status: 'active',
    }).lean();
    if (!installations.length) {
      return res.json({ installations: [] });
    }
    const podIds = installations.map((i) => i.podId).filter(Boolean);
    const pods = await Pod.find({ _id: { $in: podIds } })
      .select('name members createdBy')
      .lean();
    const podMap = new Map(pods.map((pod) => [pod._id.toString(), pod]));
    const results = installations
      .map((install) => {
        const pod = podMap.get(install.podId?.toString?.());
        if (!pod || !userHasPodAccess(pod, userId)) return null;
        return {
          podId: pod._id,
          podName: pod.name,
          instanceId: install.instanceId,
        };
      })
      .filter(Boolean);
    return res.json({ installations: results });
  } catch (error) {
    console.error('Error listing agent installations:', error);
    return res.status(500).json({ error: 'Failed to list installations' });
  }
});

/**
 * DELETE /api/registry/admin/installations/:installationId/runtime-tokens/:tokenId
 * Revoke a runtime token for an installation (admin only)
 */
router.delete('/admin/installations/:installationId/runtime-tokens/:tokenId', auth, adminAuth, async (req, res) => {
  try {
    const { installationId, tokenId } = req.params;
    const installation = await AgentInstallation.findById(installationId);
    if (!installation) {
      return res.status(404).json({ error: 'Installation not found' });
    }

    const originalCount = installation.runtimeTokens?.length || 0;
    installation.runtimeTokens = (installation.runtimeTokens || []).filter(
      (token) => token._id?.toString() !== tokenId,
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
router.delete('/admin/installations/:installationId', auth, adminAuth, async (req, res) => {
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
    } catch (identityError) {
      console.warn('Failed to remove agent user from pod:', identityError.message);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error uninstalling admin installation:', error);
    return res.status(500).json({ error: 'Failed to uninstall installation' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/user-token
 * Get metadata for the agent's designated user token (no raw token returned)
 */
router.get('/pods/:podId/agents/:name/user-token', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { installation, instanceId } = await resolveInstallation({
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
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUsername = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
    const agentUser = await User.findOne({ username: agentUsername }).lean();
    if (!agentUser || !agentUser.apiToken) {
      return res.json({ hasToken: false, scopes: [] });
    }

    return res.json({
      hasToken: true,
      createdAt: agentUser.apiTokenCreatedAt || null,
      scopes: agentUser.apiTokenScopes || [],
    });
  } catch (error) {
    console.error('Error fetching agent user token metadata:', error);
    return res.status(500).json({ error: 'Failed to fetch user token metadata' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/user-token
 * Issue a designated user API token for the agent user
 */
router.post('/pods/:podId/agents/:name/user-token', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { scopes, instanceId, displayName } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
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
    const normalizedInstanceId = resolved.instanceId;

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const issued = await issueUserTokenForInstallation({
      agentName: name,
      instanceId: normalizedInstanceId,
      displayName: displayName || installation.displayName,
      podId,
      scopes,
    });

    return res.json(issued);
  } catch (error) {
    console.error('Error issuing agent user token:', error);
    return res.status(500).json({ error: 'Failed to issue user token' });
  }
});

/**
 * DELETE /api/registry/pods/:podId/agents/:name/user-token
 * Revoke designated user token for the agent user
 */
router.delete('/pods/:podId/agents/:name/user-token', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { installation, instanceId } = await resolveInstallation({
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
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUsername = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
    const agentUser = await User.findOne({ username: agentUsername });
    if (!agentUser) {
      return res.status(404).json({ error: 'Agent user not found' });
    }

    agentUser.revokeApiToken();
    agentUser.apiTokenScopes = [];
    await agentUser.save();

    return res.json({ success: true });
  } catch (error) {
    console.error('Error revoking agent user token:', error);
    return res.status(500).json({ error: 'Failed to revoke user token' });
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
    const normalizedInstanceId = resolved.instanceId;

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
      });
    }

    const baseUrl = process.env.COMMONLY_API_URL
      || process.env.COMMONLY_BASE_URL
      || 'http://backend:5000';

    const configPayload = normalizeConfigMap(installation.config) || {};
    const runtimeAuthProfiles = normalizeRuntimeAuthProfiles(configPayload?.runtime?.authProfiles) || null;
    const runtimeSkillEnv = normalizeSkillEnvEntries(configPayload?.runtime?.skillEnv) || null;
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    // Only provision if we have a new token (not existing)
    let provisioned = { accountId: null, configPath: null, restartRequired: false };
    const shouldProvision = Boolean(runtimeIssued.token || runtimeAuthProfiles || runtimeSkillEnv);
    if (shouldProvision) {
      provisioned = provisionAgentRuntime({
        runtimeType,
        agentName: name,
        instanceId: normalizedInstanceId,
        runtimeToken: runtimeIssued.token || null,
        userToken: userIssued?.token,
        baseUrl,
        displayName: installation.displayName,
        heartbeat: configPayload.heartbeat || null,
        gateway,
        authProfiles: runtimeAuthProfiles,
        skillEnv: runtimeSkillEnv,
      });
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

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-status
 * Check local runtime status (docker).
 */
router.get('/pods/:podId/agents/:name/runtime-status', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const instanceId = normalizeInstanceId(req.query.instanceId || 'default');
    const gatewayId = req.query.gatewayId || null;

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

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || instanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const status = await getAgentRuntimeStatus(runtimeType, effectiveInstanceId, { gateway });
    return res.json({ runtimeType, status, gatewayId: gateway?._id || null, gatewaySlug: gateway?.slug || null });
  } catch (error) {
    console.error('Error fetching runtime status:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch runtime status' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-start
 */
router.post('/pods/:podId/agents/:name/runtime-start', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

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

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: normalizedInstanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || normalizedInstanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const started = await startAgentRuntime(runtimeType, effectiveInstanceId, { gateway });
    return res.json({ runtimeType, started, gatewayId: gateway?._id || null, gatewaySlug: gateway?.slug || null });
  } catch (error) {
    console.error('Error starting runtime:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to start runtime' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-stop
 */
router.post('/pods/:podId/agents/:name/runtime-stop', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

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

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: normalizedInstanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || normalizedInstanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const stopped = await stopAgentRuntime(runtimeType, effectiveInstanceId, { gateway });
    return res.json({ runtimeType, stopped, gatewayId: gateway?._id || null, gatewaySlug: gateway?.slug || null });
  } catch (error) {
    console.error('Error stopping runtime:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to stop runtime' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-restart
 */
router.post('/pods/:podId/agents/:name/runtime-restart', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

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

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: normalizedInstanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || normalizedInstanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const restarted = await restartAgentRuntime(runtimeType, effectiveInstanceId, { gateway });
    return res.json({ runtimeType, restarted, gatewayId: gateway?._id || null, gatewaySlug: gateway?.slug || null });
  } catch (error) {
    console.error('Error restarting runtime:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to restart runtime' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-logs
 */
router.get('/pods/:podId/agents/:name/runtime-logs', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const lines = Number(req.query.lines || 200);
    const instanceId = normalizeInstanceId(req.query.instanceId || 'default');
    const gatewayId = req.query.gatewayId || null;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
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

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || instanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const filterTokens = buildRuntimeLogFilters({ runtimeType, agentName: name, instanceId: effectiveInstanceId });
    const logs = await getAgentRuntimeLogs(runtimeType, effectiveInstanceId, lines, { gateway, filterTokens });
    return res.json({
      runtimeType,
      ...logs,
      gatewayId: gateway?._id || null,
      gatewaySlug: gateway?.slug || null,
    });
  } catch (error) {
    console.error('Error fetching runtime logs:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch runtime logs' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/plugins
 * List OpenClaw plugins (local gateway).
 */
router.get('/pods/:podId/agents/:name/plugins', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
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

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }
    if (runtimeType !== 'moltbot') {
      return res.status(400).json({ error: 'Plugin management is only supported for OpenClaw' });
    }

    const plugins = await listOpenClawPlugins();
    return res.json({ runtimeType, ...plugins });
  } catch (error) {
    console.error('Error fetching OpenClaw plugins:', error);
    return res.status(500).json({ error: 'Failed to list plugins' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/plugins/install
 * Install an OpenClaw plugin in the local gateway.
 */
router.post('/pods/:podId/agents/:name/plugins/install', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { spec, pluginId, link = false, restart = false } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!spec || typeof spec !== 'string') {
      return res.status(400).json({ error: 'spec is required' });
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

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }
    if (runtimeType !== 'moltbot') {
      return res.status(400).json({ error: 'Plugin management is only supported for OpenClaw' });
    }

    const pluginReport = await listOpenClawPlugins();
    const normalizedPluginId = normalizePluginIdentifier(pluginId);
    const specNormalized = normalizePluginIdentifier(spec);
    const specBase = getPluginSpecBase(spec);
    const candidates = new Set([
      normalizedPluginId,
      specNormalized,
      specBase,
    ].filter(Boolean));
    const existing = (pluginReport.plugins || []).find((plugin) => {
      const pluginIdValue = normalizePluginIdentifier(plugin?.id);
      const pluginNameValue = normalizePluginIdentifier(plugin?.name);
      return candidates.has(pluginIdValue) || candidates.has(pluginNameValue);
    });
    if (existing) {
      return res.status(409).json({
        error: 'Plugin already installed',
        plugin: existing,
        alreadyInstalled: true,
      });
    }

    const installResult = await installOpenClawPlugin({ spec, link: Boolean(link) });
    let restartResult = null;
    if (restart) {
      restartResult = await restartDockerRuntime(runtimeType);
    }

    return res.json({
      installed: true,
      spec,
      link: Boolean(link),
      restartRequired: true,
      output: installResult.stdout,
      errorOutput: installResult.stderr,
      command: installResult.command,
      restart: restartResult,
    });
  } catch (error) {
    console.error('Error installing OpenClaw plugin:', error);
    return res.status(500).json({ error: 'Failed to install plugin' });
  }
});

/**
 * PATCH /api/registry/pods/:podId/agents/:name
 * Update agent configuration in a pod
 */
router.post('/pods/:podId/agents/:name/persona/generate', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId } = req.body;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
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

    if (!resolved.installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const profile = await AgentProfile.findOne({
      agentId: buildAgentProfileId(name, resolved.instanceId),
      podId,
    }).lean();

    const displayName = resolved.installation.displayName || profile?.name || name;
    const purpose = profile?.purpose || resolved.installation?.displayName || name;
    const seed = Math.floor(Math.random() * 1000000);

    const prompt = [
      'You are generating a random but useful persona for an AI agent in a team workspace.',
      `Seed: ${seed}.`,
      `Agent name: ${displayName}.`,
      `Agent purpose/summary: ${purpose}.`,
      'Return ONLY JSON with this shape:',
      '{',
      '  "tone": "string",',
      '  "specialties": ["string", "..."],',
      '  "boundaries": ["string", "..."],',
      '  "customInstructions": "1-2 sentences.",',
      '  "exampleInstructions": "3-6 short bullet lines as plain text, no markdown."',
      '}',
      'Keep specialties and boundaries concrete and short. Avoid emojis.',
    ].join('\n');

    let generated = null;
    try {
      const text = await generateText(prompt, { temperature: 0.7 });
      generated = parseJsonFromText(text);
    } catch (error) {
      console.warn('Persona generation failed, using fallback:', error.message);
    }

    if (!generated || typeof generated !== 'object') {
      generated = {
        tone: 'friendly',
        specialties: ['insight synthesis', 'clear explanations', 'actionable next steps'],
        boundaries: ['avoid speculation', 'ask clarifying questions when unsure', 'be concise'],
        customInstructions: 'Keep answers practical and structured.',
        exampleInstructions: [
          '- Summarize the key points first.',
          '- Ask one clarifying question if needed.',
          '- Offer a concrete next step.',
        ].join('\n'),
      };
    }

    return res.json({
      success: true,
      seed,
      persona: {
        tone: generated.tone || 'friendly',
        specialties: Array.isArray(generated.specialties) ? generated.specialties : [],
        boundaries: Array.isArray(generated.boundaries) ? generated.boundaries : [],
        customInstructions: generated.customInstructions || '',
      },
      exampleInstructions: generated.exampleInstructions || '',
    });
  } catch (error) {
    console.error('Error generating agent persona:', error);
    return res.status(500).json({ error: 'Failed to generate persona' });
  }
});

router.post('/pods/:podId/agents/:name/heartbeat-file', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, content, reset } = req.body;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (name.toLowerCase() !== 'openclaw') {
      return res.status(400).json({ error: 'Heartbeat file updates are only supported for OpenClaw agents.' });
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

    if (!resolved.installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const normalizedInstanceId = normalizeInstanceId(resolved.instanceId);
    const accountId = normalizedInstanceId;
    const trimmed = String(content || '').trim();
    const normalized = trimmed
      ? (trimmed.startsWith('#') ? `${trimmed}\n` : `# HEARTBEAT.md\n\n${trimmed}\n`)
      : '# HEARTBEAT.md\n\n';

    const filePath = writeOpenClawHeartbeatFile(accountId, normalized, { allowEmpty: true });

    return res.json({ success: true, path: filePath, reset: Boolean(reset) });
  } catch (error) {
    console.error('Error updating heartbeat file:', error);
    return res.status(500).json({ error: 'Failed to update heartbeat file' });
  }
});

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

    // Update fields
    if (config) {
      const existingConfig = normalizeConfigMap(installation.config) || {};
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
      installation.config = new Map(Object.entries(nextConfig));
    }
    if (scopes) {
      installation.scopes = scopes;
    }
    if (status && ['active', 'paused'].includes(status)) {
      installation.status = status;
    }
    if (displayName) {
      installation.displayName = displayName;
    }

    await installation.save();

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
      await AgentProfile.updateOne(
        { agentId: buildAgentProfileId(name, normalizedInstanceId), podId },
        updates,
      );
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
    const { manifest, readme } = req.body;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!manifest?.name || !manifest?.version) {
      return res.status(400).json({ error: 'Manifest must include name and version' });
    }

    // Check if agent already exists
    let agent = await AgentRegistry.getByName(manifest.name);

    if (agent) {
      // Check ownership
      if (agent.publisher?.userId?.toString() !== userId.toString()) {
        return res.status(403).json({ error: 'Not authorized to update this agent' });
      }

      // Add new version
      agent.versions.push({
        version: manifest.version,
        manifest,
        publishedAt: new Date(),
      });
      agent.latestVersion = manifest.version;
      agent.manifest = manifest;
      if (readme) agent.readme = readme;
      await agent.save();
    } else {
      // Create new agent
      agent = await AgentRegistry.create({
        agentName: manifest.name.toLowerCase(),
        displayName: manifest.name,
        description: manifest.description || '',
        readme,
        manifest,
        latestVersion: manifest.version,
        versions: [
          {
            version: manifest.version,
            manifest,
            publishedAt: new Date(),
          },
        ],
        registry: 'commonly-community',
        publisher: {
          userId,
          name: req.user.username,
        },
        categories: manifest.categories || [],
        tags: manifest.tags || [],
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
