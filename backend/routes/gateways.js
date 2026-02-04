const express = require('express');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const Gateway = require('../models/Gateway');
const { getOpenClawConfigPath } = require('../services/agentProvisionerService');

const router = express.Router();

const slugify = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

const getUserId = (req) => req.userId || req.user?.id || req.user?._id;

const ensureDefaultGateway = async (userId) => {
  const existing = await Gateway.findOne({ slug: 'default' });
  if (existing) return existing;
  const configPath = getOpenClawConfigPath();
  return Gateway.create({
    name: 'Local Gateway',
    slug: 'default',
    type: 'openclaw',
    mode: 'local',
    configPath: configPath || '',
    status: 'active',
    createdBy: userId || undefined,
  });
};

// GET /api/gateways
router.get('/', auth, adminAuth, async (req, res) => {
  try {
    await ensureDefaultGateway(getUserId(req));
    const gateways = await Gateway.find().sort({ createdAt: 1 }).lean();
    return res.json({ gateways });
  } catch (error) {
    console.error('Error listing gateways:', error);
    return res.status(500).json({ error: 'Failed to list gateways' });
  }
});

// POST /api/gateways
router.post('/', auth, adminAuth, async (req, res) => {
  try {
    const {
      name,
      slug,
      type = 'openclaw',
      mode = 'local',
      baseUrl = '',
      configPath = '',
      status = 'active',
      metadata = {},
    } = req.body || {};

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    const resolvedSlug = slugify(slug || name);
    if (!resolvedSlug) {
      return res.status(400).json({ error: 'slug is required' });
    }

    const existing = await Gateway.findOne({ slug: resolvedSlug });
    if (existing) {
      return res.status(400).json({ error: 'slug already exists' });
    }

    const gateway = await Gateway.create({
      name,
      slug: resolvedSlug,
      type,
      mode,
      baseUrl,
      configPath,
      status,
      metadata,
      createdBy: getUserId(req),
    });

    return res.status(201).json({ gateway });
  } catch (error) {
    console.error('Error creating gateway:', error);
    return res.status(500).json({ error: 'Failed to create gateway' });
  }
});

// PATCH /api/gateways/:id
router.patch('/:id', auth, adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };
    if (updates.slug) {
      updates.slug = slugify(updates.slug);
    }
    const gateway = await Gateway.findByIdAndUpdate(id, updates, { new: true });
    if (!gateway) {
      return res.status(404).json({ error: 'Gateway not found' });
    }
    return res.json({ gateway });
  } catch (error) {
    console.error('Error updating gateway:', error);
    return res.status(500).json({ error: 'Failed to update gateway' });
  }
});

// DELETE /api/gateways/:id
router.delete('/:id', auth, adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const gateway = await Gateway.findById(id);
    if (!gateway) {
      return res.status(404).json({ error: 'Gateway not found' });
    }
    if (gateway.slug === 'default') {
      return res.status(400).json({ error: 'Default gateway cannot be removed' });
    }
    await gateway.deleteOne();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting gateway:', error);
    return res.status(500).json({ error: 'Failed to delete gateway' });
  }
});

module.exports = router;
