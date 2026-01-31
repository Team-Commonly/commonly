/**
 * Agent Registry Routes
 *
 * API for the agent "package manager" - discover, install, configure agents.
 */

const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');
const AgentProfile = require('../models/AgentProfile');
const Activity = require('../models/Activity');
const Pod = require('../models/Pod');
const User = require('../models/User');
const AgentIdentityService = require('../services/agentIdentityService');
const { hash, randomSecret } = require('../utils/secret');

const parseVerifiedFilter = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
};

const getUserId = (req) => req.userId || req.user?.id || req.user?._id;

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
      agentName, podId, version, config = {}, scopes = [],
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

    // Check if already installed
    const existing = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      podId,
      status: 'active',
    });

    if (existing) {
      return res.status(400).json({ error: 'Agent already installed in this pod' });
    }

    // Validate scopes against manifest
    const requiredScopes = agent.manifest.context?.required || [];
    const missingScopes = requiredScopes.filter((s) => !scopes.includes(s));
    if (missingScopes.length > 0) {
      return res.status(400).json({
        error: 'Missing required scopes',
        missingScopes,
      });
    }

    // Create installation
    const installation = await AgentInstallation.install(agentName, podId, {
      version: version || agent.latestVersion,
      config,
      scopes: [...requiredScopes, ...scopes],
      installedBy: userId,
    });

    // Create agent profile for the pod
    await AgentProfile.create({
      agentId: agentName,
      podId,
      name: agent.displayName,
      purpose: agent.description,
      instructions: agent.manifest.configSchema?.defaultInstructions || '',
      persona: {
        tone: 'friendly',
        specialties: agent.manifest.capabilities?.map((c) => c.name) || [],
      },
      toolPolicy: {
        allowed: scopes.filter((s) => s.includes(':')).map((s) => s.split(':')[0]),
      },
      createdBy: userId,
    });

    try {
      const agentUser = await AgentIdentityService.getOrCreateAgentUser(agent.agentName);
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

    res.json({
      success: true,
      installation: {
        id: installation._id.toString(),
        agentName: installation.agentName,
        version: installation.version,
        status: installation.status,
        scopes: installation.scopes,
      },
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

    const installation = await AgentInstallation.findOne({
      agentName: name.toLowerCase(),
      podId,
    }).lean();

    if (!installation) {
      if (!isCreator) {
        return res.status(404).json({ error: 'Agent not installed in this pod' });
      }

      await AgentProfile.deleteOne({ agentId: name.toLowerCase(), podId });
      try {
        await AgentIdentityService.removeAgentFromPod(name, podId);
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
    await AgentInstallation.uninstall(name, podId);

    // Remove agent profile
    await AgentProfile.deleteOne({ agentId: name.toLowerCase(), podId });

    try {
      await AgentIdentityService.removeAgentFromPod(name, podId);
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

    // Get agent profiles for more details
    const profiles = await AgentProfile.find({
      podId,
      agentId: { $in: installations.map((i) => i.agentName) },
    }).lean();

    res.json({
      agents: installations.map((i) => {
        const profile = profiles.find((p) => p.agentId === i.agentName);
        return {
          name: i.agentName,
          version: i.version,
          status: i.status,
          scopes: i.scopes,
          installedAt: i.createdAt,
          usage: i.usage,
          installedBy: i.installedBy?.toString?.() || i.installedBy,
          profile: profile
            ? {
              displayName: profile.name,
              purpose: profile.purpose,
              isDefault: profile.isDefault,
              modelPreferences: profile.modelPreferences,
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

    const installation = await AgentInstallation.findOne({
      agentName: name.toLowerCase(),
      podId,
      status: 'active',
    }).lean();

    if (!installation) {
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
    const { label } = req.body || {};
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

    const installation = await AgentInstallation.findOne({
      agentName: name.toLowerCase(),
      podId,
      status: 'active',
    });

    if (!installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const rawToken = `cm_agent_${randomSecret(32)}`;
    installation.runtimeTokens = installation.runtimeTokens || [];
    installation.runtimeTokens.push({
      tokenHash: hash(rawToken),
      label: label || 'Runtime token',
      createdAt: new Date(),
    });

    await installation.save();

    return res.json({
      token: rawToken,
      label: label || 'Runtime token',
    });
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

    const installation = await AgentInstallation.findOne({
      agentName: name.toLowerCase(),
      podId,
      status: 'active',
    });

    if (!installation) {
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
 * PATCH /api/registry/pods/:podId/agents/:name
 * Update agent configuration in a pod
 */
router.patch('/pods/:podId/agents/:name', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { config, scopes, status, modelPreferences } = req.body;
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
    });

    if (!installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    // Update fields
    if (config) {
      installation.config = new Map(Object.entries(config));
    }
    if (scopes) {
      installation.scopes = scopes;
    }
    if (status && ['active', 'paused'].includes(status)) {
      installation.status = status;
    }

    await installation.save();

    // Update agent profile if needed
    if (status || modelPreferences) {
      const updates = {};
      if (status) updates.status = status;
      if (modelPreferences) updates.modelPreferences = modelPreferences;
      await AgentProfile.updateOne({ agentId: name.toLowerCase(), podId }, updates);
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
    const defaultAgents = [
      {
        agentName: 'commonly-bot',
        displayName: 'Commonly Bot',
        description: 'Posts summaries and integration highlights into pods',
        registry: 'commonly-official',
        categories: ['productivity', 'communication'],
        tags: ['summaries', 'integrations', 'platform'],
        verified: true,
        iconUrl: '/icons/commonly-bot.png',
        manifest: {
          name: 'commonly-bot',
          version: '1.0.0',
          capabilities: [
            { name: 'summaries', description: 'Post summaries into pods' },
            { name: 'integration-updates', description: 'Share integration activity' },
          ],
          context: { required: ['context:read', 'summaries:read'] },
          models: {
            supported: ['gemini-2.0-flash'],
            recommended: 'gemini-2.0-flash',
          },
          runtime: {
            type: 'standalone',
            connection: 'rest',
          },
        },
        latestVersion: '1.0.0',
        versions: [{ version: '1.0.0', publishedAt: new Date() }],
        stats: { installs: 0, rating: 0, ratingCount: 0 },
      },
      {
        agentName: 'clawdbot-bridge',
        displayName: 'Clawdbot Bridge',
        description: 'Routes Commonly events through Clawdbot and posts responses into pods',
        registry: 'commonly-official',
        categories: ['productivity', 'communication'],
        tags: ['clawdbot', 'bridge', 'assistant'],
        verified: true,
        iconUrl: null,
        manifest: {
          name: 'clawdbot-bridge',
          version: '1.0.0',
          capabilities: [
            { name: 'assistant', description: 'Respond to integration summaries' },
            { name: 'multi-agent', description: 'Bridge external Clawdbot runtimes' },
          ],
          context: { required: ['context:read', 'summaries:read', 'messages:write'] },
          runtime: {
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

module.exports = router;
