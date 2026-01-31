/**
 * Context API Routes (v1)
 *
 * These routes power the MCP server and other agents connecting to Commonly.
 * Base path: /api/v1
 */

const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const ContextAssemblerService = require('../services/contextAssemblerService');
const PodAsset = require('../models/PodAsset');
const Summary = require('../models/Summary');
const Pod = require('../models/Pod');
const VectorSearchService = require('../services/vectorSearchService');

const isMember = (pod, userId) => (
  pod.members?.some((member) => {
    if (!member) return false;
    if (member.userId) return member.userId.toString() === userId.toString();
    return member.toString() === userId.toString();
  })
);

/**
 * GET /api/v1/pods
 * List pods the authenticated user has access to
 */
router.get('/pods', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    // Find pods where user is a member
    const pods = await Pod.find({
      members: userId,
    }).lean();

    const result = pods.map((pod) => {
      const membership = pod.members?.find((m) => {
        if (!m) return false;
        if (m.userId) return m.userId.toString() === userId.toString();
        return m.toString() === userId.toString();
      });
      return {
        id: pod._id.toString(),
        name: pod.name,
        description: pod.description,
        type: pod.type,
        role: membership?.role || (pod.createdBy?.toString() === userId.toString() ? 'admin' : 'member'),
      };
    });

    res.json({ pods: result });
  } catch (error) {
    console.error('Error listing pods:', error);
    res.status(500).json({ error: 'Failed to list pods' });
  }
});

/**
 * GET /api/v1/pods/:podId
 * Get a specific pod
 */
router.get('/pods/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const userId = req.userId || req.user?._id || req.user?.id;

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    // Check membership
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      if (m.userId) return m.userId.toString() === userId.toString();
      return m.toString() === userId.toString();
    });
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      id: pod._id.toString(),
      name: pod.name,
      description: pod.description,
      type: pod.type,
      role: membership.role || (pod.createdBy?.toString() === userId.toString() ? 'admin' : 'member'),
    });
  } catch (error) {
    console.error('Error getting pod:', error);
    res.status(500).json({ error: 'Failed to get pod' });
  }
});

/**
 * GET /api/v1/context/:podId
 * Get assembled context for a pod
 */
router.get('/context/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const {
      task, includeSkills, includeMemory, maxTokens,
    } = req.query;
    const userId = req.userId || req.user?._id || req.user?.id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => {
      if (!m) return false;
      if (m.userId) return m.userId.toString() === userId.toString();
      return m.toString() === userId.toString();
    });
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const context = await ContextAssemblerService.assembleContext(podId, {
      task,
      includeSkills: includeSkills !== 'false',
      includeMemory: includeMemory !== 'false',
      maxTokens: maxTokens ? parseInt(maxTokens, 10) : 8000,
      userId,
    });

    res.json(context);
  } catch (error) {
    console.error('Error assembling context:', error);
    res.status(500).json({ error: 'Failed to assemble context' });
  }
});

/**
 * GET /api/v1/search/:podId
 * Search pod memory
 */
router.get('/search/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const {
      q, limit, types, since,
    } = req.query;
    const userId = req.userId || req.user?._id || req.user?.id;

    if (!q) {
      return res.status(400).json({ error: 'Query (q) is required' });
    }

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => {
      if (!m) return false;
      if (m.userId) return m.userId.toString() === userId.toString();
      return m.toString() === userId.toString();
    });
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const startTime = Date.now();

    const assets = await ContextAssemblerService.searchAssets(podId, q, {
      limit: limit ? parseInt(limit, 10) : 10,
      types: types ? types.split(',') : null,
    });

    // Filter by since date if provided
    let results = assets;
    if (since) {
      const sinceDate = new Date(since);
      results = assets.filter((a) => new Date(a.createdAt) >= sinceDate);
    }

    const searchTime = Date.now() - startTime;

    res.json({
      results: results.map((a) => ({
        id: a._id.toString(),
        title: a.title,
        snippet: a.content?.substring(0, 300),
        source: {
          type: a.type,
          ref: a.sourceRef?.id?.toString(),
        },
        relevance: a.relevance || 0,
        matchType: 'keyword', // TODO: Update when vector search is added
      })),
      meta: {
        query: q,
        totalResults: results.length,
        searchTime,
      },
    });
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * POST /api/v1/pods/:podId/index/rebuild
 * Rebuild vector index for a pod (admin only)
 */
router.post('/pods/:podId/index/rebuild', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { reset } = req.body || {};
    const userId = req.userId || req.user?._id || req.user?.id;

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (!isMember(pod, userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (pod.createdBy?.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (reset) {
      await VectorSearchService.resetIndex(podId);
    }

    const result = await VectorSearchService.rebuildIndex(podId);

    return res.json({
      podId,
      reset: Boolean(reset),
      ...result,
    });
  } catch (error) {
    console.error('Error rebuilding vector index:', error);
    return res.status(500).json({ error: 'Failed to rebuild vector index' });
  }
});

/**
 * POST /api/v1/index/rebuild-all
 * Rebuild vector indices for pods owned by the current user
 */
router.post('/index/rebuild-all', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;
    const { reset } = req.body || {};

    const pods = await Pod.find({ createdBy: userId }).lean();
    if (!pods.length) {
      return res.json({ pods: 0, indexed: 0, errors: 0, total: 0, reset: Boolean(reset) });
    }

    let indexed = 0;
    let errors = 0;
    let total = 0;

    for (const pod of pods) {
      if (reset) {
        await VectorSearchService.resetIndex(pod._id);
      }
      const result = await VectorSearchService.rebuildIndex(pod._id);
      indexed += result.indexed || 0;
      errors += result.errors || 0;
      total += result.total || 0;
    }

    return res.json({ pods: pods.length, indexed, errors, total, reset: Boolean(reset) });
  } catch (error) {
    console.error('Error rebuilding vector indices:', error);
    return res.status(500).json({ error: 'Failed to rebuild vector indices' });
  }
});

/**
 * GET /api/v1/pods/:podId/index/stats
 * Get vector index stats for a pod
 */
router.get('/pods/:podId/index/stats', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const userId = req.userId || req.user?._id || req.user?.id;

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (!isMember(pod, userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const stats = await VectorSearchService.getStats(podId);
    return res.json({ podId, stats });
  } catch (error) {
    console.error('Error fetching vector index stats:', error);
    return res.status(500).json({ error: 'Failed to fetch vector index stats' });
  }
});

/**
 * GET /api/v1/pods/:podId/assets/:assetId
 * Read a specific asset
 */
router.get('/pods/:podId/assets/:assetId', auth, async (req, res) => {
  try {
    const { podId, assetId } = req.params;
    const userId = req.userId || req.user?._id || req.user?.id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => {
      if (!m) return false;
      if (m.userId) return m.userId.toString() === userId.toString();
      return m.toString() === userId.toString();
    });
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const asset = await PodAsset.findOne({ _id: assetId, podId }).lean();
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json({
      id: asset._id.toString(),
      title: asset.title,
      type: asset.type,
      content: asset.content,
      tags: asset.tags || [],
      source: asset.sourceRef,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    });
  } catch (error) {
    console.error('Error reading asset:', error);
    res.status(500).json({ error: 'Failed to read asset' });
  }
});

/**
 * GET /api/v1/pods/:podId/memory/:path
 * Read a memory file (MEMORY.md, SKILLS.md, daily logs)
 */
router.get('/pods/:podId/memory/:path(*)', auth, async (req, res) => {
  try {
    const { podId, path } = req.params;
    const userId = req.userId || req.user?._id || req.user?.id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => {
      if (!m) return false;
      if (m.userId) return m.userId.toString() === userId.toString();
      return m.toString() === userId.toString();
    });
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const content = await ContextAssemblerService.readMemoryFile(podId, path);

    res.json({ content });
  } catch (error) {
    console.error('Error reading memory file:', error);
    if (error.message?.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to read memory file' });
  }
});

/**
 * POST /api/v1/memory/:podId
 * Write to pod memory
 */
router.post('/memory/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const {
      target, content, tags, source,
    } = req.body;
    const userId = req.userId || req.user?._id || req.user?.id;

    if (!target || !content) {
      return res.status(400).json({ error: 'target and content are required' });
    }

    if (!['daily', 'memory', 'skill'].includes(target)) {
      return res.status(400).json({ error: 'Invalid target. Must be: daily, memory, or skill' });
    }

    // Verify access (need write permission)
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => {
      if (!m) return false;
      if (m.userId) return m.userId.toString() === userId.toString();
      return m.toString() === userId.toString();
    });
    if (!membership || membership.role === 'viewer') {
      return res.status(403).json({ error: 'Write access denied' });
    }

    const result = await ContextAssemblerService.writeMemory(podId, {
      target,
      content,
      tags: tags || [],
      source: {
        ...source,
        userId: userId.toString(),
      },
    });

    res.json(result);
  } catch (error) {
    console.error('Error writing memory:', error);
    res.status(500).json({ error: 'Failed to write memory' });
  }
});

/**
 * GET /api/v1/pods/:podId/skills
 * Get pod skills
 */
router.get('/pods/:podId/skills', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { tags, limit } = req.query;
    const userId = req.userId || req.user?._id || req.user?.id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => {
      if (!m) return false;
      if (m.userId) return m.userId.toString() === userId.toString();
      return m.toString() === userId.toString();
    });
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const query = {
      podId,
      type: 'skill',
    };

    if (tags) {
      query.tags = { $in: tags.split(',') };
    }

    const skills = await PodAsset.find(query)
      .sort({ updatedAt: -1 })
      .limit(limit ? parseInt(limit, 10) : 50)
      .lean();

    res.json({
      skills: skills.map((s) => ({
        id: s._id.toString(),
        name: s.title,
        description: s.content?.substring(0, 200),
        instructions: s.content,
        tags: s.tags || [],
        sourceAssetIds: s.sourceRef ? [s.sourceRef.toString()] : [],
      })),
    });
  } catch (error) {
    console.error('Error getting skills:', error);
    res.status(500).json({ error: 'Failed to get skills' });
  }
});

/**
 * GET /api/v1/pods/:podId/summaries
 * Get recent summaries
 */
router.get('/pods/:podId/summaries', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { hours, types, limit } = req.query;
    const userId = req.userId || req.user?._id || req.user?.id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => {
      if (!m) return false;
      if (m.userId) return m.userId.toString() === userId.toString();
      return m.toString() === userId.toString();
    });
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const summaries = await ContextAssemblerService.getRecentSummaries(podId, {
      hours: hours ? parseInt(hours, 10) : 24,
      types: types ? types.split(',') : null,
      limit: limit ? parseInt(limit, 10) : 10,
    });

    res.json({
      summaries: summaries.map((s) => ({
        id: s._id.toString(),
        type: s.type,
        content: s.content,
        period: {
          start: s.timeRange?.start?.toISOString() || s.createdAt?.toISOString(),
          end: s.timeRange?.end?.toISOString() || s.createdAt?.toISOString(),
        },
        metadata: s.metadata,
      })),
    });
  } catch (error) {
    console.error('Error getting summaries:', error);
    res.status(500).json({ error: 'Failed to get summaries' });
  }
});

module.exports = router;
