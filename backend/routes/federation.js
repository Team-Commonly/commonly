/**
 * Federation Routes
 *
 * API for cross-pod linking and federated queries.
 */

const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const PodLink = require('../models/PodLink');
const FederationService = require('../services/federationService');
const Pod = require('../models/Pod');
const getAuthenticatedUserId = require('../utils/getAuthenticatedUserId');

/**
 * GET /api/federation/pods/:podId/links
 * List all links for a pod (incoming and outgoing)
 */
router.get('/pods/:podId/links', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { direction = 'both' } = req.query;
    const userId = getAuthenticatedUserId(req);

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const links = await PodLink.getLinksForPod(podId, direction);

    res.json({
      links: links.map((link) => ({
        id: link._id.toString(),
        sourcePod: {
          id: link.sourcePodId._id.toString(),
          name: link.sourcePodId.name,
          type: link.sourcePodId.type,
        },
        targetPod: {
          id: link.targetPodId._id.toString(),
          name: link.targetPodId.name,
          type: link.targetPodId.type,
        },
        scopes: link.scopes,
        status: link.status,
        usage: link.usage,
        createdAt: link.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error listing links:', error);
    res.status(500).json({ error: 'Failed to list links' });
  }
});

/**
 * GET /api/federation/pods/:podId/requests
 * List pending link requests for a pod
 */
router.get('/pods/:podId/requests', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const userId = getAuthenticatedUserId(req);

    // Verify admin access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership || membership.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const requests = await PodLink.getPendingRequests(podId);

    res.json({
      requests: requests.map((r) => ({
        id: r._id.toString(),
        fromPod: {
          id: r.targetPodId._id.toString(),
          name: r.targetPodId.name,
          type: r.targetPodId.type,
        },
        requestedBy: r.requestedBy
          ? {
            id: r.requestedBy._id.toString(),
            username: r.requestedBy.username,
          }
          : null,
        scopes: r.scopes,
        message: r.message,
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error listing requests:', error);
    res.status(500).json({ error: 'Failed to list requests' });
  }
});

/**
 * POST /api/federation/links
 * Request a link to another pod
 */
router.post('/links', auth, async (req, res) => {
  try {
    const {
      sourcePodId, targetPodId, scopes, message,
    } = req.body;
    const userId = getAuthenticatedUserId(req);

    if (!sourcePodId || !targetPodId || !scopes || scopes.length === 0) {
      return res.status(400).json({ error: 'sourcePodId, targetPodId, and scopes are required' });
    }

    // Verify user is admin of target pod (requesting pod)
    const targetPod = await Pod.findById(targetPodId).lean();
    if (!targetPod) {
      return res.status(404).json({ error: 'Target pod not found' });
    }

    const membership = targetPod.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership || membership.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to request links' });
    }

    // Verify source pod exists
    const sourcePod = await Pod.findById(sourcePodId).lean();
    if (!sourcePod) {
      return res.status(404).json({ error: 'Source pod not found' });
    }

    // Create link request
    const link = await PodLink.requestLink({
      sourcePodId,
      targetPodId,
      scopes,
      requestedBy: userId,
      message,
    });

    res.json({
      success: true,
      link: {
        id: link._id.toString(),
        status: link.status,
        scopes: link.scopes,
      },
    });
  } catch (error) {
    console.error('Error requesting link:', error);
    res.status(500).json({ error: error.message || 'Failed to request link' });
  }
});

/**
 * POST /api/federation/links/:linkId/approve
 * Approve a pending link request
 */
router.post('/links/:linkId/approve', auth, async (req, res) => {
  try {
    const { linkId } = req.params;
    const userId = getAuthenticatedUserId(req);

    const link = await PodLink.findById(linkId);
    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    // Verify user is admin of source pod
    const sourcePod = await Pod.findById(link.sourcePodId).lean();
    const membership = sourcePod?.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership || membership.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to approve links' });
    }

    await link.approve(userId);

    res.json({
      success: true,
      link: {
        id: link._id.toString(),
        status: link.status,
      },
    });
  } catch (error) {
    console.error('Error approving link:', error);
    res.status(500).json({ error: error.message || 'Failed to approve link' });
  }
});

/**
 * POST /api/federation/links/:linkId/revoke
 * Revoke an active link
 */
router.post('/links/:linkId/revoke', auth, async (req, res) => {
  try {
    const { linkId } = req.params;
    const { reason } = req.body;
    const userId = getAuthenticatedUserId(req);

    const link = await PodLink.findById(linkId);
    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    // Verify user is admin of source pod
    const sourcePod = await Pod.findById(link.sourcePodId).lean();
    const membership = sourcePod?.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership || membership.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to revoke links' });
    }

    await link.revoke(userId, reason);

    res.json({
      success: true,
      link: {
        id: link._id.toString(),
        status: link.status,
      },
    });
  } catch (error) {
    console.error('Error revoking link:', error);
    res.status(500).json({ error: error.message || 'Failed to revoke link' });
  }
});

/**
 * POST /api/federation/query
 * Query a linked pod
 */
router.post('/query', auth, async (req, res) => {
  try {
    const {
      sourcePodId, targetPodId, queryType, filters = {}, limit = 10,
    } = req.body;
    const userId = getAuthenticatedUserId(req);

    if (!sourcePodId || !targetPodId || !queryType) {
      return res.status(400).json({ error: 'sourcePodId, targetPodId, and queryType are required' });
    }

    // Verify user has access to source pod
    const sourcePod = await Pod.findById(sourcePodId).lean();
    if (!sourcePod) {
      return res.status(404).json({ error: 'Source pod not found' });
    }

    const membership = sourcePod.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await FederationService.queryLinkedPod({
      sourcePodId,
      targetPodId,
      queryType,
      filters,
      actorId: userId,
      actorType: 'human',
      limit,
    });

    res.json(result);
  } catch (error) {
    console.error('Error querying linked pod:', error);
    res.status(500).json({ error: error.message || 'Failed to query linked pod' });
  }
});

/**
 * GET /api/federation/pods/:podId/accessible
 * Get all pods accessible through links
 */
router.get('/pods/:podId/accessible', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const userId = getAuthenticatedUserId(req);

    // Verify access
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const accessiblePods = await FederationService.getAccessiblePods(podId);

    res.json({ pods: accessiblePods });
  } catch (error) {
    console.error('Error getting accessible pods:', error);
    res.status(500).json({ error: 'Failed to get accessible pods' });
  }
});

/**
 * POST /api/federation/search
 * Search across all accessible pods
 */
router.post('/search', auth, async (req, res) => {
  try {
    const {
      sourcePodId, query, queryTypes = ['skills', 'assets'], limit = 10,
    } = req.body;
    const userId = getAuthenticatedUserId(req);

    if (!sourcePodId || !query) {
      return res.status(400).json({ error: 'sourcePodId and query are required' });
    }

    // Verify access
    const pod = await Pod.findById(sourcePodId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const results = await FederationService.federatedSearch({
      sourcePodId,
      query,
      queryTypes,
      actorId: userId,
      actorType: 'human',
      limit,
    });

    res.json({ results });
  } catch (error) {
    console.error('Error in federated search:', error);
    res.status(500).json({ error: 'Failed to search' });
  }
});

/**
 * GET /api/federation/links/:linkId/audit
 * Get audit log for a link
 */
router.get('/links/:linkId/audit', auth, async (req, res) => {
  try {
    const { linkId } = req.params;
    const { limit = 50 } = req.query;
    const userId = getAuthenticatedUserId(req);

    const link = await PodLink.findById(linkId)
      .populate('auditLog.actorId', 'username')
      .lean();

    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    // Verify user is admin of source pod
    const sourcePod = await Pod.findById(link.sourcePodId).lean();
    const membership = sourcePod?.members?.find((m) => m.userId?.toString() === userId.toString());
    if (!membership || membership.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const auditLog = link.auditLog
      .slice(-parseInt(limit, 10))
      .reverse()
      .map((entry) => ({
        action: entry.action,
        actor: entry.actorId
          ? {
            id: entry.actorId._id?.toString() || entry.actorId.toString(),
            username: entry.actorId.username,
          }
          : null,
        actorType: entry.actorType,
        timestamp: entry.timestamp,
        details: entry.details,
      }));

    res.json({ auditLog });
  } catch (error) {
    console.error('Error getting audit log:', error);
    res.status(500).json({ error: 'Failed to get audit log' });
  }
});

module.exports = router;
