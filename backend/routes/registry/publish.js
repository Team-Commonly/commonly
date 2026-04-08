// Agent publish/seed/avatar routes — extracted from registry.js (GH#112)
// Handles: POST /publish, POST /seed, POST /generate-avatar
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentRegistry } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { getUserId } = require('./helpers');
const {
  ManifestValidationError,
  normalizePublishPayload,
} = require('../../utils/agentManifestRegistry');

const publishRouter = express.Router();

/**
 * POST /api/registry/publish
 * Publish a new agent to the registry (for developers)
 */
publishRouter.post('/publish', auth, async (req, res) => {
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

    let agent = await AgentRegistry.getByName(manifest.name);
    const versionPayload = {
      version: manifest.version,
      manifest,
      publishedAt: new Date(),
    };

    if (agent) {
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
publishRouter.post('/seed', auth, async (req, res) => {
  try {
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
            supported: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-1.5-pro'],
            recommended: 'gemini-2.5-pro',
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
 * POST /api/registry/generate-avatar
 * Generate AI avatar for an agent
 */
publishRouter.post('/generate-avatar', auth, async (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const AgentAvatarService = require('../../services/agentAvatarService');
    const {
      agentName, style, personality, colorScheme, gender, customPrompt,
    } = req.body;

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

    const avatarResult = await AgentAvatarService.generateAvatarDetailed({
      agentName,
      style: style || 'realistic',
      personality: personality || 'friendly',
      colorScheme: colorScheme || 'vibrant',
      gender: gender || 'neutral',
      customPrompt: customPrompt || '',
    });
    const avatarDataUri = avatarResult.avatar;

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

module.exports = publishRouter;
