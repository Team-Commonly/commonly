// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const ContextAssemblerService = require('../services/contextAssemblerService');
// eslint-disable-next-line global-require
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const VectorSearchService = require('../services/vectorSearchService');
// eslint-disable-next-line global-require
const User = require('../models/User');

interface AuthReq {
  userId?: string;
  user?: { _id?: unknown; id?: string; isBot?: boolean; botMetadata?: { agentType?: string; agentName?: string; instanceId?: string }; username?: string };
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const getUid = (req: AuthReq) => req.userId || req.user?._id || req.user?.id;

const isMember = (pod: { members?: Array<unknown> }, userId: unknown) => pod.members?.some((member) => {
  if (!member) return false;
  const m = member as { userId?: { toString: () => string }; toString: () => string };
  if (m.userId) return m.userId.toString() === (userId as { toString: () => string }).toString();
  return m.toString() === (userId as { toString: () => string }).toString();
});

const resolveAgentContext = (user: AuthReq['user'] | null) => user?.isBot
  ? { agentName: user.botMetadata?.agentType || user.botMetadata?.agentName || user.username, instanceId: user.botMetadata?.instanceId || 'default' }
  : null;

const findMembership = (pod: { members?: Array<unknown> }, userId: unknown) => pod.members?.find((m) => {
  if (!m) return false;
  const mem = m as { userId?: { toString: () => string }; toString: () => string };
  if (mem.userId) return mem.userId.toString() === (userId as { toString: () => string }).toString();
  return mem.toString() === (userId as { toString: () => string }).toString();
});

router.get('/pods', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUid(req);
    const pods = await Pod.find({ members: userId }).lean() as Array<Record<string, unknown> & { _id: { toString: () => string }; name?: string; description?: string; type?: string; createdBy?: { toString: () => string }; members?: Array<unknown> }>;
    const result = pods.map((pod) => {
      const membership = findMembership(pod, userId) as { role?: string } | undefined;
      return { id: pod._id.toString(), name: pod.name, description: pod.description, type: pod.type, role: membership?.role || (pod.createdBy?.toString() === (userId as { toString: () => string })?.toString() ? 'admin' : 'member') };
    });
    res.json({ pods: result });
  } catch (error) {
    console.error('Error listing pods:', error);
    res.status(500).json({ error: 'Failed to list pods' });
  }
});

router.get('/pods/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const userId = getUid(req);
    const pod = await Pod.findById(podId).lean() as Record<string, unknown> & { _id: { toString: () => string }; name?: string; description?: string; type?: string; createdBy?: { toString: () => string }; members?: Array<unknown> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const membership = findMembership(pod, userId) as { role?: string } | undefined;
    if (!membership) return res.status(403).json({ error: 'Access denied' });
    res.json({ id: pod._id.toString(), name: pod.name, description: pod.description, type: pod.type, role: membership.role || (pod.createdBy?.toString() === (userId as { toString: () => string })?.toString() ? 'admin' : 'member') });
  } catch (error) {
    console.error('Error getting pod:', error);
    res.status(500).json({ error: 'Failed to get pod' });
  }
});

router.get('/context/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { task, includeSkills, includeMemory, maxTokens } = req.query || {};
    const userId = getUid(req);
    const pod = await Pod.findById(podId).lean() as { members?: Array<unknown> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (!findMembership(pod, userId)) return res.status(403).json({ error: 'Access denied' });
    const user = userId ? await User.findById(userId).lean() as AuthReq['user'] | null : null;
    const agentContext = resolveAgentContext(user);
    const context = await ContextAssemblerService.assembleContext(podId, { task, includeSkills: includeSkills !== 'false', includeMemory: includeMemory !== 'false', maxTokens: maxTokens ? parseInt(maxTokens, 10) : 8000, userId, agentContext });
    res.json(context);
  } catch (error) {
    console.error('Error assembling context:', error);
    res.status(500).json({ error: 'Failed to assemble context' });
  }
});

router.get('/search/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { q, limit, types, since } = req.query || {};
    const userId = getUid(req);
    if (!q) return res.status(400).json({ error: 'Query (q) is required' });
    const pod = await Pod.findById(podId).lean() as { members?: Array<unknown> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (!findMembership(pod, userId)) return res.status(403).json({ error: 'Access denied' });
    const startTime = Date.now();
    const user = userId ? await User.findById(userId).lean() as AuthReq['user'] | null : null;
    const agentContext = resolveAgentContext(user);
    const assets = await ContextAssemblerService.searchAssets(podId, q, { limit: limit ? parseInt(limit, 10) : 10, types: types ? types.split(',') : null, agentContext }) as Array<Record<string, unknown>>;
    let results = assets;
    if (since) { const sinceDate = new Date(since); results = assets.filter((a) => new Date(a.createdAt as string) >= sinceDate); }
    res.json({ results: results.map((a) => ({ id: (a._id as { toString: () => string }).toString(), title: a.title, snippet: (a.content as string)?.substring(0, 300), source: { type: a.type, ref: (a.sourceRef as { id?: { toString: () => string } })?.id?.toString() }, relevance: a.relevance || 0, matchType: 'keyword' })), meta: { query: q, totalResults: results.length, searchTime: Date.now() - startTime } });
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

router.post('/pods/:podId/index/rebuild', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { reset } = req.body || {};
    const userId = getUid(req);
    const pod = await Pod.findById(podId).lean() as { members?: Array<unknown>; createdBy?: { toString: () => string } } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (!isMember(pod, userId)) return res.status(403).json({ error: 'Access denied' });
    if (pod.createdBy?.toString() !== (userId as { toString: () => string })?.toString()) return res.status(403).json({ error: 'Admin access required' });
    if (reset) await VectorSearchService.resetIndex(podId);
    const result = await VectorSearchService.rebuildIndex(podId);
    return res.json({ podId, reset: Boolean(reset), ...result });
  } catch (error) {
    console.error('Error rebuilding vector index:', error);
    return res.status(500).json({ error: 'Failed to rebuild vector index' });
  }
});

router.post('/index/rebuild-all', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUid(req);
    const { reset } = req.body || {};
    const pods = await Pod.find({ createdBy: userId }).lean() as Array<{ _id: unknown }>;
    if (!pods.length) return res.json({ pods: 0, indexed: 0, errors: 0, total: 0, reset: Boolean(reset) });
    let indexed = 0; let errors = 0; let total = 0;
    for (const pod of pods) {
      if (reset) await VectorSearchService.resetIndex(pod._id);
      const result = await VectorSearchService.rebuildIndex(pod._id) as { indexed?: number; errors?: number; total?: number };
      indexed += result.indexed || 0; errors += result.errors || 0; total += result.total || 0;
    }
    return res.json({ pods: pods.length, indexed, errors, total, reset: Boolean(reset) });
  } catch (error) {
    console.error('Error rebuilding vector indices:', error);
    return res.status(500).json({ error: 'Failed to rebuild vector indices' });
  }
});

router.get('/pods/:podId/index/stats', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const userId = getUid(req);
    const pod = await Pod.findById(podId).lean() as { members?: Array<unknown> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (!isMember(pod, userId)) return res.status(403).json({ error: 'Access denied' });
    const stats = await VectorSearchService.getStats(podId);
    return res.json({ podId, stats });
  } catch (error) {
    console.error('Error fetching vector index stats:', error);
    return res.status(500).json({ error: 'Failed to fetch vector index stats' });
  }
});

router.get('/pods/:podId/assets/:assetId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, assetId } = req.params || {};
    const userId = getUid(req);
    const pod = await Pod.findById(podId).lean() as { members?: Array<unknown> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (!findMembership(pod, userId)) return res.status(403).json({ error: 'Access denied' });
    const asset = await PodAsset.findOne({ _id: assetId, podId }).lean() as Record<string, unknown> & { _id: { toString: () => string } } | null;
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ id: asset._id.toString(), title: asset.title, type: asset.type, content: asset.content, tags: asset.tags || [], source: asset.sourceRef, createdAt: asset.createdAt, updatedAt: asset.updatedAt });
  } catch (error) {
    console.error('Error reading asset:', error);
    res.status(500).json({ error: 'Failed to read asset' });
  }
});

router.get('/pods/:podId/memory/:path(*)', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, path } = req.params || {};
    const userId = getUid(req);
    const user = userId ? await User.findById(userId).lean() as AuthReq['user'] | null : null;
    const agentContext = resolveAgentContext(user);
    const pod = await Pod.findById(podId).lean() as { members?: Array<unknown> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (!findMembership(pod, userId)) return res.status(403).json({ error: 'Access denied' });
    const content = await ContextAssemblerService.readMemoryFile(podId, path, { agentContext });
    res.json({ content });
  } catch (error) {
    const e = error as Error;
    console.error('Error reading memory file:', error);
    if (e.message?.includes('not found')) return res.status(404).json({ error: e.message });
    res.status(500).json({ error: 'Failed to read memory file' });
  }
});

router.post('/memory/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { target, content, tags, source, scope } = req.body || {} as { target?: string; content?: string; tags?: unknown[]; source?: unknown; scope?: string };
    const userId = getUid(req);
    const user = userId ? await User.findById(userId).lean() as AuthReq['user'] | null : null;
    const agentContext = resolveAgentContext(user);
    if (!target || !content) return res.status(400).json({ error: 'target and content are required' });
    if (!['daily', 'memory', 'skill'].includes(target as string)) return res.status(400).json({ error: 'Invalid target. Must be: daily, memory, or skill' });
    const pod = await Pod.findById(podId).lean() as { members?: Array<unknown> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const membership = findMembership(pod, userId) as { role?: string } | undefined;
    if (!membership || membership.role === 'viewer') return res.status(403).json({ error: 'Write access denied' });
    const result = await ContextAssemblerService.writeMemory(podId, { target, content, tags: tags || [], source: { ...(source as Record<string, unknown>), userId: (userId as { toString: () => string })?.toString() }, scope: scope || (agentContext ? 'agent' : 'pod'), agentContext });
    res.json(result);
  } catch (error) {
    console.error('Error writing memory:', error);
    res.status(500).json({ error: 'Failed to write memory' });
  }
});

router.get('/pods/:podId/skills', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { tags, limit } = req.query || {};
    const userId = getUid(req);
    const pod = await Pod.findById(podId).lean() as { members?: Array<unknown> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (!findMembership(pod, userId)) return res.status(403).json({ error: 'Access denied' });
    const query: Record<string, unknown> = { podId, type: 'skill' };
    if (tags) query.tags = { $in: tags.split(',') };
    const skills = await PodAsset.find(query).sort({ updatedAt: -1 }).limit(limit ? parseInt(limit, 10) : 50).lean() as Array<Record<string, unknown> & { _id: { toString: () => string } }>;
    res.json({ skills: skills.map((s) => ({ id: s._id.toString(), name: s.title, description: (s.content as string)?.substring(0, 200), instructions: s.content, tags: s.tags || [], sourceAssetIds: s.sourceRef ? [s.sourceRef.toString()] : [] })) });
  } catch (error) {
    console.error('Error getting skills:', error);
    res.status(500).json({ error: 'Failed to get skills' });
  }
});

router.get('/pods/:podId/summaries', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { hours, types, limit } = req.query || {};
    const userId = getUid(req);
    const pod = await Pod.findById(podId).lean() as { members?: Array<unknown> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (!findMembership(pod, userId)) return res.status(403).json({ error: 'Access denied' });
    const summaries = await ContextAssemblerService.getRecentSummaries(podId, { hours: hours ? parseInt(hours, 10) : 24, types: types ? types.split(',') : null, limit: limit ? parseInt(limit, 10) : 10 }) as Array<Record<string, unknown>>;
    res.json({ summaries: summaries.map((s) => ({ id: (s._id as { toString: () => string }).toString(), type: s.type, content: s.content, period: { start: (s.timeRange as { start?: { toISOString: () => string } })?.start?.toISOString() || (s.createdAt as { toISOString: () => string })?.toISOString(), end: (s.timeRange as { end?: { toISOString: () => string } })?.end?.toISOString() || (s.createdAt as { toISOString: () => string })?.toISOString() }, metadata: s.metadata })) });
  } catch (error) {
    console.error('Error getting summaries:', error);
    res.status(500).json({ error: 'Failed to get summaries' });
  }
});

module.exports = router;

export {};
