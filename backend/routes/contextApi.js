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

/**
 * GET /api/v1/pods
 * List pods the authenticated user has access to
 */
router.get('/pods', auth, async (req, res) => {
  try {
    const userId = req.user._id;

    // Find pods where user is a member
    const pods = await Pod.find({
      'members.userId': userId,
    }).lean();

    const result = pods.map((pod) => {
      const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
      return {
        id: pod._id.toString(),
        name: pod.name,
        description: pod.description,
        type: pod.type,
        role: membership?.role || 'viewer',
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
    const userId = req.user._id;

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    // Check membership
    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      id: pod._id.toString(),
      name: pod.name,
      description: pod.description,
      type: pod.type,
      role: membership.role,
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
    const userId = req.user._id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
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
    const userId = req.user._id;

    if (!q) {
      return res.status(400).json({ error: 'Query (q) is required' });
    }

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
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
 * GET /api/v1/pods/:podId/assets/:assetId
 * Read a specific asset
 */
router.get('/pods/:podId/assets/:assetId', auth, async (req, res) => {
  try {
    const { podId, assetId } = req.params;
    const userId = req.user._id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
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
    const userId = req.user._id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
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
    const userId = req.user._id;

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

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
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
    const userId = req.user._id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
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
    const userId = req.user._id;

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
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
