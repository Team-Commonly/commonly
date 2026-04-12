// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const JSON5 = require('json5');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const adminAuth = require('../middleware/adminAuth');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line global-require
const Gateway = require('../models/Gateway');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const PodAssetService = require('../services/podAssetService');
// eslint-disable-next-line global-require
const SkillsCatalogService = require('../services/skillsCatalogService');
// eslint-disable-next-line global-require
const { getOpenClawConfigPath, syncOpenClawSkills, getGatewaySkillEntries, syncGatewaySkillEnv } = require('../services/agentProvisionerService');
// eslint-disable-next-line global-require
const SkillRating = require('../models/SkillRating');

interface AuthReq {
  user?: { id: string };
  userId?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}
interface PodError extends Error {
  code?: string;
}

const router: ReturnType<typeof express.Router> = express.Router();

const getUserId = (req: AuthReq): string | undefined => req.user?.id || req.userId;

const normalizeConfigMap = (config: unknown): Record<string, unknown> => {
  if (!config) return {};
  if (config instanceof Map) return Object.fromEntries(config.entries());
  if (typeof config === 'object') return config as Record<string, unknown>;
  return {};
};

const extractCredentialMetadata = (content: string | undefined): { envs: string[]; primaryEnv: string | null } => {
  const metadata: { envs: string[]; primaryEnv: string | null } = { envs: [], primaryEnv: null };
  if (!content) return metadata;
  const frontmatterMatch = content.match(/^---\s*([\s\S]*?)\s*---/);
  if (!frontmatterMatch) return metadata;
  const frontmatter = frontmatterMatch[1];
  const metadataLine = frontmatter.split('\n').find((line) => line.trim().startsWith('metadata:'));
  if (!metadataLine) return metadata;
  const raw = metadataLine.split('metadata:')[1]?.trim();
  if (!raw) return metadata;
  try {
    const parsed = JSON5.parse(raw);
    const moltbot = parsed?.moltbot || {};
    const envs = moltbot?.requires?.env || moltbot?.requires?.envs || [];
    if (Array.isArray(envs)) metadata.envs = envs.map((env: unknown) => String(env || '').trim()).filter(Boolean);
    metadata.primaryEnv = String(moltbot?.primaryEnv || moltbot?.requires?.primaryEnv || '').trim() || null;
  } catch (error) {
    console.warn('[skills] Failed to parse metadata JSON in skill frontmatter:', (error as Error).message);
  }
  return metadata;
};

const extractCredentialHints = (content: string | undefined, metadataOverride?: { envs: string[]; primaryEnv: string | null }): string[] => {
  if (!content) return [];
  const envPattern = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g;
  const keywordPattern = /(KEY|TOKEN|SECRET|CLIENT|ACCESS|PROJECT|OPENAI|ANTHROPIC|GEMINI|GOOGLE|SERP|BING|BRAVE|SLACK|DISCORD|GITHUB|TWITTER|X_|FACEBOOK|INSTAGRAM)/;
  const hits = new Set<string>();
  const metadata = metadataOverride || extractCredentialMetadata(content);
  if (metadata?.envs?.length) metadata.envs.forEach((env) => hits.add(String(env).trim()));
  let match: RegExpExecArray | null;
  while ((match = envPattern.exec(content)) !== null) {
    if (keywordPattern.test(match[0])) hits.add(match[0]);
  }
  return Array.from(hits).filter(Boolean).sort();
};

const ensurePodAccess = async (podId: string, userId: unknown) => {
  const pod = await Pod.findById(podId).lean() as Record<string, unknown> & { createdBy?: { toString: () => string }; members?: Array<{ userId?: { toString: () => string }; toString: () => string }> } | null;
  if (!pod) { const e = new Error('Pod not found') as PodError; e.code = 'POD_NOT_FOUND'; throw e; }
  const userIdStr = userId?.toString();
  const isCreator = pod.createdBy?.toString() === userIdStr;
  const isMember = pod.members?.some((m) => (m.userId?.toString() || m.toString()) === userIdStr);
  if (!isCreator && !isMember) { const e = new Error('Access denied') as PodError; e.code = 'POD_ACCESS_DENIED'; throw e; }
  return pod;
};

const ensureDefaultGateway = async (userId: unknown) => {
  const existing = await Gateway.findOne({ slug: 'default' });
  if (existing) return existing;
  const configPath = getOpenClawConfigPath();
  return Gateway.create({ name: 'Local Gateway', slug: 'default', type: 'openclaw', mode: 'local', baseUrl: '', configPath: configPath || '', status: 'active', createdBy: userId || undefined });
};

const syncOpenClawInstallationsForPodSkillChange = async ({ podId }: { podId: string }) => {
  const installations = await AgentInstallation.find({ podId, agentName: 'openclaw', status: 'active' }).lean() as Array<Record<string, unknown>>;
  if (!installations.length) return { attempted: 0, synced: 0, failed: 0, items: [] };
  const items = await Promise.all(installations.map(async (installation) => {
    const instanceId = String(installation.instanceId || 'default').trim() || 'default';
    const config = normalizeConfigMap(installation.config);
    const skillSync = (config?.skillSync || null) as Record<string, unknown> | null;
    const mode = skillSync?.mode === 'selected' ? 'selected' : 'all';
    let podIdsToSync: string[] = Array.isArray(skillSync?.podIds)
      ? (skillSync.podIds as unknown[]).map((id) => String(id)).filter(Boolean)
      : [String(podId)];
    if (skillSync?.allPods) {
      const linked = await AgentInstallation.find({ agentName: 'openclaw', instanceId, status: 'active' }).select('podId').lean() as Array<{ podId?: { toString?: () => string } }>;
      podIdsToSync = linked.map((e) => e.podId?.toString?.()).filter(Boolean) as string[];
    }
    const gatewayId = (config?.runtime as Record<string, unknown>)?.gatewayId;
    const gateway = gatewayId ? await Gateway.findById(gatewayId).lean() : null;
    try {
      const syncedPath = await syncOpenClawSkills({ accountId: instanceId, podIds: podIdsToSync, mode, skillNames: Array.isArray(skillSync?.skillNames) ? skillSync.skillNames : [], gateway });
      return { instanceId, podIds: podIdsToSync, success: true, path: syncedPath };
    } catch (error) {
      return { instanceId, podIds: podIdsToSync, success: false, error: (error as Error).message };
    }
  }));
  const synced = items.filter((item) => item.success).length;
  return { attempted: items.length, synced, failed: items.length - synced, items };
};

router.get('/catalog', auth, async (req: AuthReq, res: Res) => {
  try {
    const source = String(req.query?.source || 'awesome').trim();
    const catalog = SkillsCatalogService.loadCatalog(source) as { items?: unknown[]; source?: string; updatedAt?: string };
    const allItems = Array.isArray(catalog.items) ? catalog.items as Array<Record<string, unknown>> : [];
    const query = String(req.query?.q || '').trim().toLowerCase();
    const category = String(req.query?.category || '').trim();
    const sort = String(req.query?.sort || '').trim().toLowerCase();
    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
    const parseLimit = (raw: string | undefined, fallback: number, max: number) => { const n = Number.parseInt(raw || '', 10); return Number.isNaN(n) ? fallback : clamp(n, 1, max); };
    const page = parseLimit(req.query?.page, 1, 1000);
    const limit = parseLimit(req.query?.limit, 60, 200);
    const categories = Array.from(new Set(allItems.map((item) => (item.category as string) || 'Other'))).sort();
    const filtered = allItems.filter((item) => {
      if (category && category !== 'all' && ((item.category as string) || 'Other') !== category) return false;
      if (!query) return true;
      return `${item.name || ''} ${item.description || ''}`.toLowerCase().includes(query);
    });
    const sorted = [...filtered];
    if (sort === 'stars') {
      sorted.sort((a, b) => {
        const diff = (Number.isFinite(b.stars as number) ? b.stars as number : -1) - (Number.isFinite(a.stars as number) ? a.stars as number : -1);
        return diff !== 0 ? diff : String(a.name || '').localeCompare(String(b.name || ''));
      });
    }
    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * limit;
    const refreshedAt = typeof SkillsCatalogService.getLastRefreshedAt === 'function'
      ? SkillsCatalogService.getLastRefreshedAt(source)
      : { localRefreshedAt: null, upstreamRefreshedAt: null };
    return res.json({
      source: catalog.source || source,
      updatedAt: catalog.updatedAt || null,
      localRefreshedAt: refreshedAt.localRefreshedAt || catalog.updatedAt || null,
      upstreamRefreshedAt: refreshedAt.upstreamRefreshedAt || null,
      items: sorted.slice(start, start + limit),
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

router.get('/gateway-credentials', auth, adminAuth, async (req: AuthReq, res: Res) => {
  try {
    const gatewayId = String(req.query?.gatewayId || '').trim();
    const gateway = gatewayId ? await Gateway.findById(gatewayId).lean() : await ensureDefaultGateway(getUserId(req));
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const entries = await getGatewaySkillEntries({ gateway });
    return res.json({ gatewayId: (gateway as { _id?: { toString: () => string } })._id?.toString(), entries });
  } catch (error) {
    console.error('Error loading gateway credentials:', error);
    return res.status(500).json({ error: 'Failed to load gateway credentials' });
  }
});

router.patch('/gateway-credentials', auth, adminAuth, async (req: AuthReq, res: Res) => {
  try {
    const gatewayId = String(req.query?.gatewayId || '').trim() || (req.body?.gatewayId as string | undefined);
    const entries = req.body?.entries;
    if (!entries || typeof entries !== 'object') return res.status(400).json({ error: 'entries is required' });
    const gateway = gatewayId ? await Gateway.findById(gatewayId).lean() : await ensureDefaultGateway(getUserId(req));
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    const updated = await syncGatewaySkillEnv({ gateway, entries });
    return res.json({ gatewayId: (gateway as { _id?: { toString: () => string } })._id?.toString(), entries: updated });
  } catch (error) {
    console.error('Error updating gateway credentials:', error);
    return res.status(500).json({ error: 'Failed to update gateway credentials' });
  }
});

router.get('/requirements', auth, async (req: AuthReq, res: Res) => {
  try {
    const sourceUrl = String(req.query?.sourceUrl || '').trim();
    if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl is required' });
    const fetched = await SkillsCatalogService.fetchSkillContentFromSource(sourceUrl) as { content?: string; resolvedUrl?: string };
    const content = fetched.content || '';
    const metadata = extractCredentialMetadata(content);
    const requirements = extractCredentialHints(content, metadata);
    const primaryEnv = metadata.primaryEnv || (metadata.envs.length === 1 ? metadata.envs[0] : null) || (requirements.length === 1 ? requirements[0] : null);
    return res.json({ sourceUrl: fetched.resolvedUrl || sourceUrl, requirements, primaryEnv, detectedCount: requirements.length });
  } catch (error) {
    console.error('Error fetching skill requirements:', error);
    return res.status(500).json({ error: 'Failed to fetch skill requirements' });
  }
});

router.get('/pods/:podId/imported', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUserId(req);
    const { podId } = req.params || {};
    const scope = String(req.query?.scope || 'pod').trim().toLowerCase();
    const agentName = String(req.query?.agentName || '').trim();
    const instanceId = String(req.query?.instanceId || '').trim();
    await ensurePodAccess(podId || '', userId);
    if (scope === 'agent' && (!agentName || !instanceId)) return res.status(400).json({ error: 'agentName and instanceId are required for agent scope.' });
    const query: Record<string, unknown> = { podId, type: 'skill', status: 'active' };
    if (scope === 'agent') { query['metadata.scope'] = 'agent'; query['metadata.agentName'] = agentName; query['metadata.instanceId'] = instanceId; }
    else query['metadata.scope'] = 'pod';
    const assets = await PodAsset.find(query).select('title metadata.skillName metadata.scope metadata.agentName metadata.instanceId metadata.sourceUrl metadata.description metadata.license').lean() as Array<Record<string, unknown>>;
    const items = assets.map((asset) => ({
      name: (asset?.metadata as Record<string, unknown>)?.skillName || (asset.title as string)?.replace(/^Skill:\s*/i, '') || asset.title,
      title: asset.title,
      scope: (asset?.metadata as Record<string, unknown>)?.scope || 'pod',
      agentName: (asset?.metadata as Record<string, unknown>)?.agentName || null,
      instanceId: (asset?.metadata as Record<string, unknown>)?.instanceId || null,
      sourceUrl: (asset?.metadata as Record<string, unknown>)?.sourceUrl || null,
      description: (asset?.metadata as Record<string, unknown>)?.description || null,
      license: (asset?.metadata as Record<string, unknown>)?.license || null,
    }));
    return res.json({ items });
  } catch (error) {
    console.error('Error loading imported skills:', error);
    return res.status(500).json({ error: 'Failed to load imported skills' });
  }
});

router.delete('/pods/:podId/imported', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUserId(req);
    const { podId } = req.params || {};
    const name = String(req.query?.name || '').trim();
    const scope = String(req.query?.scope || 'pod').trim().toLowerCase();
    const agentName = String(req.query?.agentName || '').trim();
    const instanceId = String(req.query?.instanceId || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    await ensurePodAccess(podId || '', userId);
    if (scope === 'agent' && (!agentName || !instanceId)) return res.status(400).json({ error: 'agentName and instanceId are required for agent scope.' });
    const skillKey = PodAssetService.buildScopedSkillKey({ name, scope, agentName: scope === 'agent' ? agentName : undefined, instanceId: scope === 'agent' ? instanceId : undefined });
    const asset = await PodAsset.findOneAndUpdate({ podId, type: 'skill', status: 'active', 'metadata.skillKey': skillKey }, { $set: { status: 'archived' } }, { new: true }) as { _id: unknown } | null;
    if (!asset) return res.status(404).json({ error: 'Skill not found' });
    const sync = await syncOpenClawInstallationsForPodSkillChange({ podId: podId || '' });
    return res.json({ success: true, assetId: asset._id, sync });
  } catch (error) {
    console.error('Error uninstalling skill:', error);
    return res.status(500).json({ error: 'Failed to uninstall skill' });
  }
});

router.post('/import', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUserId(req);
    const { podId, name, content, tags = [], sourceUrl, license, scope = 'pod', agentName, instanceId, description } = (req.body || {}) as { podId?: string; name?: string; content?: string; tags?: string[]; sourceUrl?: string; license?: string; scope?: string; agentName?: string; instanceId?: string; description?: string };
    if (!podId || !name) return res.status(400).json({ error: 'podId and name are required' });
    await ensurePodAccess(podId, userId);
    let skillContent = content;
    let resolvedSourceUrl = sourceUrl;
    let extraFiles: unknown[] = [];
    if (!skillContent && sourceUrl) {
      const fetched = await SkillsCatalogService.fetchSkillContentFromSource(sourceUrl) as { content?: string; resolvedUrl?: string };
      skillContent = fetched.content;
      resolvedSourceUrl = fetched.resolvedUrl || sourceUrl;
    }
    if (resolvedSourceUrl) {
      extraFiles = await SkillsCatalogService.fetchSkillDirectoryFiles(resolvedSourceUrl, { maxFiles: 60, maxBytes: 300_000 });
    }
    if (!skillContent) return res.status(400).json({ error: 'Skill content is required (provide content or a SKILL.md source URL).' });
    const normalizedScope = scope === 'agent' ? 'agent' : 'pod';
    const metadata = { scope: normalizedScope, agentName: normalizedScope === 'agent' ? agentName : undefined, instanceId: normalizedScope === 'agent' ? instanceId : undefined, sourceUrl: resolvedSourceUrl || null, license: license || null, description: description || null, importedAt: new Date().toISOString(), tags, extraFiles };
    const asset = await PodAssetService.upsertImportedSkillAsset({ podId, name, markdown: skillContent, tags, metadata, createdBy: userId }) as { _id?: unknown } | null;
    const sync = await syncOpenClawInstallationsForPodSkillChange({ podId });
    return res.status(201).json({ assetId: asset?._id, podId, name, scope: normalizedScope, sync });
  } catch (error) {
    const e = error as PodError;
    console.error('Error importing skill:', error);
    return res.status(e.code === 'POD_ACCESS_DENIED' ? 403 : 500).json({ error: e.message || 'Failed to import skill' });
  }
});

// ============================================================================
// Skill ratings + comments
// ============================================================================

const normalizeSkillId = (raw: string | undefined): string => String(raw || '').trim();

const clampRating = (raw: unknown): number | null => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
};

// POST /api/skills/:skillId/rating — create or update the caller's rating.
router.post('/:skillId/rating', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const skillId = normalizeSkillId(req.params?.skillId);
    if (!skillId) return res.status(400).json({ error: 'skillId is required' });
    const rating = clampRating((req.body || {}).rating);
    if (rating === null) return res.status(400).json({ error: 'rating must be an integer 1-5' });
    const rawComment = (req.body || {}).comment;
    const comment = typeof rawComment === 'string' ? rawComment.trim().slice(0, 2000) : '';
    const doc = await SkillRating.findOneAndUpdate(
      { skillId, userId },
      { $set: { rating, comment } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return res.status(200).json({ rating: doc });
  } catch (error) {
    console.error('Error saving skill rating:', error);
    return res.status(500).json({ error: 'Failed to save rating' });
  }
});

// GET /api/skills/:skillId/ratings — paginated list, newest first.
router.get('/:skillId/ratings', auth, async (req: AuthReq, res: Res) => {
  try {
    const skillId = normalizeSkillId(req.params?.skillId);
    if (!skillId) return res.status(400).json({ error: 'skillId is required' });
    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
    const limit = clamp(Number.parseInt(String(req.query?.limit || '20'), 10) || 20, 1, 100);
    const skip = Math.max(0, Number.parseInt(String(req.query?.skip || '0'), 10) || 0);
    const rows = await SkillRating.find({ skillId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'username profilePicture')
      .lean();
    const items = (rows as Array<Record<string, unknown>>).map((row) => {
      const user = row.userId as { _id?: unknown; username?: string; profilePicture?: string } | null;
      return {
        _id: row._id,
        skillId: row.skillId,
        rating: row.rating,
        comment: row.comment || '',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        user: user ? {
          _id: user._id,
          username: user.username || 'unknown',
          profilePicture: user.profilePicture || 'default',
        } : null,
      };
    });
    return res.json({ items, total: items.length, skip, limit });
  } catch (error) {
    console.error('Error listing skill ratings:', error);
    return res.status(500).json({ error: 'Failed to load ratings' });
  }
});

// GET /api/skills/:skillId/ratings/summary — aggregate stats.
router.get('/:skillId/ratings/summary', auth, async (req: AuthReq, res: Res) => {
  try {
    const skillId = normalizeSkillId(req.params?.skillId);
    if (!skillId) return res.status(400).json({ error: 'skillId is required' });
    const summary = await SkillRating.getAggregated(skillId);
    const userId = getUserId(req);
    let mine: { rating: number; comment: string } | null = null;
    if (userId) {
      const own = await SkillRating.findOne({ skillId, userId }).lean() as { rating?: number; comment?: string } | null;
      if (own) mine = { rating: own.rating || 0, comment: own.comment || '' };
    }
    return res.json({ ...summary, mine });
  } catch (error) {
    console.error('Error loading skill rating summary:', error);
    return res.status(500).json({ error: 'Failed to load rating summary' });
  }
});

// DELETE /api/skills/:skillId/rating — remove the caller's own rating.
router.delete('/:skillId/rating', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const skillId = normalizeSkillId(req.params?.skillId);
    if (!skillId) return res.status(400).json({ error: 'skillId is required' });
    const result = await SkillRating.findOneAndDelete({ skillId, userId });
    if (!result) return res.status(404).json({ error: 'Rating not found' });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting skill rating:', error);
    return res.status(500).json({ error: 'Failed to delete rating' });
  }
});

// GET /api/skills/ratings/summary?skillIds=a,b,c — batch aggregate (for the
// catalog list so we don't issue one HTTP call per card).
router.get('/ratings/summary', auth, async (req: AuthReq, res: Res) => {
  try {
    const raw = String(req.query?.skillIds || '').trim();
    if (!raw) return res.json({ summaries: {} });
    const ids = raw.split(',').map((id) => id.trim()).filter(Boolean).slice(0, 500);
    const map = await SkillRating.getAggregatedMany(ids);
    const summaries: Record<string, unknown> = {};
    map.forEach((value: unknown, key: string) => {
      summaries[key] = value;
    });
    return res.json({ summaries });
  } catch (error) {
    console.error('Error loading batch skill rating summaries:', error);
    return res.status(500).json({ error: 'Failed to load rating summaries' });
  }
});

module.exports = router;

export {};
