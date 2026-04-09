// Agent template CRUD routes — extracted from registry.js (GH#112)
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentRegistry } = require('../../models/AgentRegistry');
const AgentTemplate = require('../../models/AgentTemplate');
const User = require('../../models/User');
const { getUserId, escapeRegExp } = require('./helpers');

const templatesRouter = express.Router();

/**
 * GET /api/registry/templates
 * List agent templates (public + creator's private)
 */
templatesRouter.get('/templates', auth, async (req: any, res: any) => {
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
      templates: templates.map((template: any) => ({
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
templatesRouter.post('/templates', auth, async (req: any, res: any) => {
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

    // Sync iconUrl to User.profilePicture so post/comment populates pick it up
    if (iconUrl) {
      const instanceId = trimmedDisplayName.toLowerCase();
      await User.updateMany(
        { 'botMetadata.agentName': agentName.toLowerCase(), 'botMetadata.instanceId': instanceId },
        { profilePicture: iconUrl },
      );
    }

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
templatesRouter.patch('/templates/:id', auth, async (req: any, res: any) => {
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

    // Sync iconUrl to User.profilePicture so post/comment populates pick it up
    if (iconUrl !== undefined) {
      const instanceId = template.displayName.toLowerCase();
      await User.updateMany(
        { 'botMetadata.agentName': template.agentName, 'botMetadata.instanceId': instanceId },
        { profilePicture: template.iconUrl || 'default' },
      );
    }

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
templatesRouter.delete('/templates/:id', auth, async (req: any, res: any) => {
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

module.exports = templatesRouter;

export {};
