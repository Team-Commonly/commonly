const express = require('express');
const fs = require('fs');
const JSON5 = require('json5');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const Pod = require('../models/Pod');
const PodAsset = require('../models/PodAsset');
const PodAssetService = require('../services/podAssetService');
const SkillsCatalogService = require('../services/skillsCatalogService');
const {
  getOpenClawConfigPath,
  syncOpenClawSkillEnv,
} = require('../services/agentProvisionerService');

const router = express.Router();

const getUserId = (req) => req.user?.id || req.user?._id || req.userId;

const extractCredentialHints = (content) => {
  if (!content) return [];
  const envPattern = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g;
  const keywordPattern = /(KEY|TOKEN|SECRET|CLIENT|ACCESS|OPENAI|ANTHROPIC|GEMINI|GOOGLE|SERP|BING|BRAVE|SLACK|DISCORD|GITHUB|TWITTER|X_|FACEBOOK|INSTAGRAM)/;
  const hits = new Set();

  let match;
  while ((match = envPattern.exec(content)) !== null) {
    const value = match[0];
    if (keywordPattern.test(value)) {
      hits.add(value);
    }
  }

  return Array.from(hits).sort();
};

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

const readOpenClawConfig = () => {
  const configPath = getOpenClawConfigPath();
  if (!configPath || !fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    if (!raw.trim()) return {};
    return JSON5.parse(raw);
  } catch (error) {
    console.warn('[skills] Failed to read OpenClaw config:', error.message);
    return {};
  }
};

const readGatewaySkillEntries = () => {
  const config = readOpenClawConfig();
  const entries = config?.skills?.entries || {};
  const output = {};
  Object.entries(entries).forEach(([skillKey, entry]) => {
    const env = entry?.env || {};
    const keys = Object.keys(env).filter(Boolean);
    output[skillKey] = { envKeys: keys };
  });
  return output;
};

// GET /api/skills/catalog?source=awesome
router.get('/catalog', auth, async (req, res) => {
  try {
    const source = String(req.query.source || 'awesome').trim();
    const catalog = SkillsCatalogService.loadCatalog(source);
    const allItems = Array.isArray(catalog.items) ? catalog.items : [];
    const query = String(req.query.q || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim();

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const parseLimit = (raw, fallback, max) => {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) return fallback;
      return clamp(parsed, 1, max);
    };
    const page = parseLimit(req.query.page, 1, 1000);
    const limit = parseLimit(req.query.limit, 60, 200);

    const categories = Array.from(
      new Set(allItems.map((item) => item.category || 'Other')),
    ).sort();

    const filtered = allItems.filter((item) => {
      if (category && category !== 'all' && (item.category || 'Other') !== category) return false;
      if (!query) return true;
      const haystack = `${item.name || ''} ${item.description || ''}`.toLowerCase();
      return haystack.includes(query);
    });

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * limit;
    const items = filtered.slice(start, start + limit);

    return res.json({
      source: catalog.source || source,
      updatedAt: catalog.updatedAt || null,
      items,
      total,
      page: safePage,
      limit,
      totalPages,
      categories,
    });
  } catch (error) {
    console.error('Error loading skills catalog:', error);
    return res.status(500).json({ error: 'Failed to load skills catalog' });
  }
});

// GET /api/skills/gateway-credentials
router.get('/gateway-credentials', auth, adminAuth, async (req, res) => {
  try {
    const entries = readGatewaySkillEntries();
    return res.json({
      gatewayId: String(req.query.gatewayId || 'default'),
      entries,
    });
  } catch (error) {
    console.error('Error loading gateway credentials:', error);
    return res.status(500).json({ error: 'Failed to load gateway credentials' });
  }
});

// PATCH /api/skills/gateway-credentials
router.patch('/gateway-credentials', auth, adminAuth, async (req, res) => {
  try {
    const entries = req.body?.entries;
    if (!entries || typeof entries !== 'object') {
      return res.status(400).json({ error: 'entries is required' });
    }
    syncOpenClawSkillEnv({ skillEnv: entries });
    const updated = readGatewaySkillEntries();
    return res.json({ gatewayId: String(req.query.gatewayId || 'default'), entries: updated });
  } catch (error) {
    console.error('Error updating gateway credentials:', error);
    return res.status(500).json({ error: 'Failed to update gateway credentials' });
  }
});

// GET /api/skills/requirements?sourceUrl=...
router.get('/requirements', auth, async (req, res) => {
  try {
    const sourceUrl = String(req.query.sourceUrl || '').trim();
    if (!sourceUrl) {
      return res.status(400).json({ error: 'sourceUrl is required' });
    }

    const fetched = await SkillsCatalogService.fetchSkillContentFromSource(sourceUrl);
    const content = fetched.content || '';
    const requirements = extractCredentialHints(content);

    return res.json({
      sourceUrl: fetched.resolvedUrl || sourceUrl,
      requirements,
      detectedCount: requirements.length,
    });
  } catch (error) {
    console.error('Error fetching skill requirements:', error);
    return res.status(500).json({ error: 'Failed to fetch skill requirements' });
  }
});

// GET /api/skills/pods/:podId/imported?scope=pod|agent&agentName=&instanceId=
router.get('/pods/:podId/imported', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { podId } = req.params;
    const scope = String(req.query.scope || 'pod').trim().toLowerCase();
    const agentName = String(req.query.agentName || '').trim();
    const instanceId = String(req.query.instanceId || '').trim();

    await ensurePodAccess(podId, userId);

    if (scope === 'agent' && (!agentName || !instanceId)) {
      return res.status(400).json({ error: 'agentName and instanceId are required for agent scope.' });
    }

    const query = { podId, type: 'skill', status: 'active' };
    if (scope === 'agent') {
      query['metadata.scope'] = 'agent';
      query['metadata.agentName'] = agentName;
      query['metadata.instanceId'] = instanceId;
    } else {
      query['metadata.scope'] = 'pod';
    }

    const assets = await PodAsset.find(query)
      .select('title metadata.skillName metadata.scope metadata.agentName metadata.instanceId metadata.sourceUrl metadata.description metadata.license')
      .lean();

    const items = assets.map((asset) => ({
      name: asset?.metadata?.skillName || asset.title?.replace(/^Skill:\s*/i, '') || asset.title,
      title: asset.title,
      scope: asset?.metadata?.scope || 'pod',
      agentName: asset?.metadata?.agentName || null,
      instanceId: asset?.metadata?.instanceId || null,
      sourceUrl: asset?.metadata?.sourceUrl || null,
      description: asset?.metadata?.description || null,
      license: asset?.metadata?.license || null,
    }));

    return res.json({ items });
  } catch (error) {
    console.error('Error loading imported skills:', error);
    return res.status(500).json({ error: 'Failed to load imported skills' });
  }
});

// DELETE /api/skills/pods/:podId/imported?name=...&scope=pod|agent&agentName=&instanceId=
router.delete('/pods/:podId/imported', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { podId } = req.params;
    const name = String(req.query.name || '').trim();
    const scope = String(req.query.scope || 'pod').trim().toLowerCase();
    const agentName = String(req.query.agentName || '').trim();
    const instanceId = String(req.query.instanceId || '').trim();

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    await ensurePodAccess(podId, userId);

    if (scope === 'agent' && (!agentName || !instanceId)) {
      return res.status(400).json({ error: 'agentName and instanceId are required for agent scope.' });
    }

    const skillKey = PodAssetService.buildScopedSkillKey({
      name,
      scope,
      agentName: scope === 'agent' ? agentName : undefined,
      instanceId: scope === 'agent' ? instanceId : undefined,
    });

    const asset = await PodAsset.findOneAndUpdate(
      { podId, type: 'skill', status: 'active', 'metadata.skillKey': skillKey },
      { $set: { status: 'archived' } },
      { new: true },
    );

    if (!asset) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    return res.json({ success: true, assetId: asset._id });
  } catch (error) {
    console.error('Error uninstalling skill:', error);
    return res.status(500).json({ error: 'Failed to uninstall skill' });
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

    if (!podId || !name) {
      return res.status(400).json({ error: 'podId and name are required' });
    }

    await ensurePodAccess(podId, userId);

    let skillContent = content;
    let resolvedSourceUrl = sourceUrl;
    if (!skillContent && sourceUrl) {
      const fetched = await SkillsCatalogService.fetchSkillContentFromSource(sourceUrl);
      skillContent = fetched.content;
      resolvedSourceUrl = fetched.resolvedUrl || sourceUrl;
    }

    if (!skillContent) {
      return res.status(400).json({ error: 'Skill content is required (provide content or a SKILL.md source URL).' });
    }

    const normalizedScope = scope === 'agent' ? 'agent' : 'pod';
    const metadata = {
      scope: normalizedScope,
      agentName: normalizedScope === 'agent' ? agentName : undefined,
      instanceId: normalizedScope === 'agent' ? instanceId : undefined,
      sourceUrl: resolvedSourceUrl || null,
      license: license || null,
      description: description || null,
      importedAt: new Date().toISOString(),
      tags: tags,
    };

    const asset = await PodAssetService.upsertImportedSkillAsset({
      podId,
      name,
      markdown: skillContent,
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
