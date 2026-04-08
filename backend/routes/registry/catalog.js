// Agent catalog browse routes — extracted from registry.js (GH#112)
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentIdentityService = require('../../services/agentIdentityService');
const { listOpenClawBundledSkills } = require('../../services/agentProvisionerService');
const {
  getUserId,
  normalizeInstanceId,
  parseVerifiedFilter,
  resolveGatewayForRequest,
  userHasPodAccess,
} = require('./helpers');

const catalogRouter = express.Router();

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

/**
 * GET /api/registry/agents
 * List available agents in the registry
 */
catalogRouter.get('/agents', auth, async (req, res) => {
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
catalogRouter.get('/agents/:name', auth, async (req, res) => {
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
 */
catalogRouter.get('/agents/:name/instances/:instanceId', auth, async (req, res) => {
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
catalogRouter.get('/agents/:name/instances', auth, async (req, res) => {
  try {
    const { name } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const installations = await AgentInstallation.find({
      agentName: name.toLowerCase(),
      status: 'active',
    }).lean();

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
catalogRouter.get('/categories', auth, async (req, res) => {
  try {
    const categories = await AgentRegistry.distinct('categories');
    res.json({ categories });
  } catch (error) {
    console.error('Error listing categories:', error);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

/**
 * GET /api/registry/openclaw/bundled-skills
 * List bundled gateway skills available under /app/skills.
 */
catalogRouter.get('/openclaw/bundled-skills', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const gatewayId = String(req.query.gatewayId || '').trim();
    const gateway = gatewayId ? await resolveGatewayForRequest({ gatewayId, userId }) : null;
    const result = await listOpenClawBundledSkills({ gateway });
    return res.json({
      skills: result.skills || [],
      gatewayId: gateway?._id?.toString?.() || null,
      deployment: result.deployment || null,
    });
  } catch (error) {
    console.error('Error listing bundled OpenClaw skills:', error);
    return res.status(500).json({ error: 'Failed to list bundled skills' });
  }
});

/**
 * GET /api/registry/agents/:name/installations
 * List pods where an agent instance is installed (user-visible only)
 */
catalogRouter.get('/agents/:name/installations', auth, async (req, res) => {
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

module.exports = catalogRouter;
