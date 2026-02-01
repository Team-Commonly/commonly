const express = require('express');
const auth = require('../middleware/auth');
const Pod = require('../models/Pod');
const PodAssetService = require('../services/podAssetService');
const SkillsCatalogService = require('../services/skillsCatalogService');

const router = express.Router();

const getUserId = (req) => req.user?.id || req.user?._id || req.userId;

const ensurePodAccess = async (podId, userId) => {
  const pod = await Pod.findById(podId).lean();
  if (!pod) {
    const error = new Error('Pod not found');
    error.code = 'POD_NOT_FOUND';
    throw error;
  }

  const userIdStr = userId?.toString();
  const isCreator = pod.createdBy?.toString() === userIdStr;
  const isMember = pod.members?.some(
    (m) => (m.userId?.toString() || m.toString()) === userIdStr,
  );

  if (!isCreator && !isMember) {
    const error = new Error('Access denied');
    error.code = 'POD_ACCESS_DENIED';
    throw error;
  }

  return pod;
};

// GET /api/skills/catalog?source=awesome
router.get('/catalog', auth, async (req, res) => {
  try {
    const source = String(req.query.source || 'awesome').trim();
    const catalog = SkillsCatalogService.loadCatalog(source);
    return res.json(catalog);
  } catch (error) {
    console.error('Error loading skills catalog:', error);
    return res.status(500).json({ error: 'Failed to load skills catalog' });
  }
});

// POST /api/skills/import
router.post('/import', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const {
      podId,
      name,
      content,
      tags = [],
      sourceUrl,
      license,
      scope = 'pod',
      agentName,
      instanceId,
      description,
    } = req.body || {};

    if (!podId || !name || !content) {
      return res.status(400).json({ error: 'podId, name, and content are required' });
    }

    await ensurePodAccess(podId, userId);

    const normalizedScope = scope === 'agent' ? 'agent' : 'pod';
    const metadata = {
      scope: normalizedScope,
      agentName: normalizedScope === 'agent' ? agentName : undefined,
      instanceId: normalizedScope === 'agent' ? instanceId : undefined,
      sourceUrl: sourceUrl || null,
      license: license || null,
      description: description || null,
      importedAt: new Date().toISOString(),
      tags: tags,
    };

    const asset = await PodAssetService.upsertImportedSkillAsset({
      podId,
      name,
      markdown: content,
      tags,
      metadata,
      createdBy: userId,
    });

    return res.status(201).json({
      assetId: asset?._id,
      podId,
      name,
      scope: normalizedScope,
    });
  } catch (error) {
    console.error('Error importing skill:', error);
    const status = error.code === 'POD_ACCESS_DENIED' ? 403 : 500;
    return res.status(status).json({ error: error.message || 'Failed to import skill' });
  }
});

module.exports = router;
