// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const PodLink = require('../models/PodLink');
// eslint-disable-next-line global-require
const FederationService = require('../services/federationService');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const getAuthenticatedUserId = require('../utils/getAuthenticatedUserId');

interface Req {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/pods/:podId/links', auth, async (req: Req, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { direction = 'both' } = req.query || {};
    const userId = getAuthenticatedUserId(req);
    const pod = await Pod.findById(podId).lean() as { members?: Array<{ userId?: { toString: () => string } }> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const membership = pod.members?.find((m) => m.userId?.toString() === String(userId));
    if (!membership) return res.status(403).json({ error: 'Access denied' });
    const links = await PodLink.getLinksForPod(podId, direction) as Array<Record<string, unknown>>;
    return res.json({ links: links.map((link) => ({ id: (link._id as { toString: () => string }).toString(), sourcePod: { id: (link.sourcePodId as Record<string, unknown>)._id?.toString(), name: (link.sourcePodId as Record<string, unknown>).name, type: (link.sourcePodId as Record<string, unknown>).type }, targetPod: { id: (link.targetPodId as Record<string, unknown>)._id?.toString(), name: (link.targetPodId as Record<string, unknown>).name, type: (link.targetPodId as Record<string, unknown>).type }, scopes: link.scopes, status: link.status, usage: link.usage, createdAt: link.createdAt })) });
  } catch (error) {
    console.error('Error listing links:', error);
    return res.status(500).json({ error: 'Failed to list links' });
  }
});

router.get('/pods/:podId/requests', auth, async (req: Req, res: Res) => {
  try {
    const { podId } = req.params || {};
    const userId = getAuthenticatedUserId(req);
    const pod = await Pod.findById(podId).lean() as { members?: Array<{ userId?: { toString: () => string }; role?: string }> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const membership = pod.members?.find((m) => m.userId?.toString() === String(userId));
    if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const requests = await PodLink.getPendingRequests(podId) as Array<Record<string, unknown>>;
    return res.json({ requests: requests.map((r) => ({ id: (r._id as { toString: () => string }).toString(), fromPod: { id: (r.targetPodId as Record<string, unknown>)._id?.toString(), name: (r.targetPodId as Record<string, unknown>).name, type: (r.targetPodId as Record<string, unknown>).type }, requestedBy: r.requestedBy ? { id: (r.requestedBy as Record<string, unknown>)._id?.toString(), username: (r.requestedBy as Record<string, unknown>).username } : null, scopes: r.scopes, message: r.message, createdAt: r.createdAt })) });
  } catch (error) {
    console.error('Error listing requests:', error);
    return res.status(500).json({ error: 'Failed to list requests' });
  }
});

router.post('/links', auth, async (req: Req, res: Res) => {
  try {
    const { sourcePodId, targetPodId, scopes, message } = (req.body || {}) as { sourcePodId?: string; targetPodId?: string; scopes?: string[]; message?: string };
    const userId = getAuthenticatedUserId(req);
    if (!sourcePodId || !targetPodId || !scopes || scopes.length === 0) return res.status(400).json({ error: 'sourcePodId, targetPodId, and scopes are required' });
    const targetPod = await Pod.findById(targetPodId).lean() as { members?: Array<{ userId?: { toString: () => string }; role?: string }> } | null;
    if (!targetPod) return res.status(404).json({ error: 'Target pod not found' });
    const membership = targetPod.members?.find((m) => m.userId?.toString() === String(userId));
    if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'Admin access required to request links' });
    const sourcePod = await Pod.findById(sourcePodId).lean();
    if (!sourcePod) return res.status(404).json({ error: 'Source pod not found' });
    const link = await PodLink.requestLink({ sourcePodId, targetPodId, scopes, requestedBy: userId, message }) as Record<string, unknown>;
    return res.json({ success: true, link: { id: (link._id as { toString: () => string }).toString(), status: link.status, scopes: link.scopes } });
  } catch (error) {
    const e = error as { message?: string };
    console.error('Error requesting link:', error);
    return res.status(500).json({ error: e.message || 'Failed to request link' });
  }
});

router.post('/links/:linkId/approve', auth, async (req: Req, res: Res) => {
  try {
    const { linkId } = req.params || {};
    const userId = getAuthenticatedUserId(req);
    const link = await PodLink.findById(linkId) as Record<string, unknown> & { sourcePodId: unknown; approve: (id: unknown) => Promise<void>; _id: { toString: () => string }; status: string } | null;
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const sourcePod = await Pod.findById(link.sourcePodId).lean() as { members?: Array<{ userId?: { toString: () => string }; role?: string }> } | null;
    const membership = sourcePod?.members?.find((m) => m.userId?.toString() === String(userId));
    if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'Admin access required to approve links' });
    await link.approve(userId);
    return res.json({ success: true, link: { id: link._id.toString(), status: link.status } });
  } catch (error) {
    const e = error as { message?: string };
    console.error('Error approving link:', error);
    return res.status(500).json({ error: e.message || 'Failed to approve link' });
  }
});

router.post('/links/:linkId/revoke', auth, async (req: Req, res: Res) => {
  try {
    const { linkId } = req.params || {};
    const { reason } = (req.body || {}) as { reason?: string };
    const userId = getAuthenticatedUserId(req);
    const link = await PodLink.findById(linkId) as Record<string, unknown> & { sourcePodId: unknown; revoke: (id: unknown, reason?: string) => Promise<void>; _id: { toString: () => string }; status: string } | null;
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const sourcePod = await Pod.findById(link.sourcePodId).lean() as { members?: Array<{ userId?: { toString: () => string }; role?: string }> } | null;
    const membership = sourcePod?.members?.find((m) => m.userId?.toString() === String(userId));
    if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'Admin access required to revoke links' });
    await link.revoke(userId, reason);
    return res.json({ success: true, link: { id: link._id.toString(), status: link.status } });
  } catch (error) {
    const e = error as { message?: string };
    console.error('Error revoking link:', error);
    return res.status(500).json({ error: e.message || 'Failed to revoke link' });
  }
});

router.post('/query', auth, async (req: Req, res: Res) => {
  try {
    const { sourcePodId, targetPodId, queryType, filters = {}, limit = 10 } = (req.body || {}) as { sourcePodId?: string; targetPodId?: string; queryType?: string; filters?: unknown; limit?: number };
    const userId = getAuthenticatedUserId(req);
    if (!sourcePodId || !targetPodId || !queryType) return res.status(400).json({ error: 'sourcePodId, targetPodId, and queryType are required' });
    const sourcePod = await Pod.findById(sourcePodId).lean() as { members?: Array<{ userId?: { toString: () => string } }> } | null;
    if (!sourcePod) return res.status(404).json({ error: 'Source pod not found' });
    const membership = sourcePod.members?.find((m) => m.userId?.toString() === String(userId));
    if (!membership) return res.status(403).json({ error: 'Access denied' });
    const result = await FederationService.queryLinkedPod({ sourcePodId, targetPodId, queryType, filters, actorId: userId, actorType: 'human', limit });
    return res.json(result);
  } catch (error) {
    const e = error as { message?: string };
    console.error('Error querying linked pod:', error);
    return res.status(500).json({ error: e.message || 'Failed to query linked pod' });
  }
});

router.get('/pods/:podId/accessible', auth, async (req: Req, res: Res) => {
  try {
    const { podId } = req.params || {};
    const userId = getAuthenticatedUserId(req);
    const pod = await Pod.findById(podId).lean() as { members?: Array<{ userId?: { toString: () => string } }> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const membership = pod.members?.find((m) => m.userId?.toString() === String(userId));
    if (!membership) return res.status(403).json({ error: 'Access denied' });
    const accessiblePods = await FederationService.getAccessiblePods(podId);
    return res.json({ pods: accessiblePods });
  } catch (error) {
    console.error('Error getting accessible pods:', error);
    return res.status(500).json({ error: 'Failed to get accessible pods' });
  }
});

router.post('/search', auth, async (req: Req, res: Res) => {
  try {
    const { sourcePodId, query, queryTypes = ['skills', 'assets'], limit = 10 } = (req.body || {}) as { sourcePodId?: string; query?: string; queryTypes?: string[]; limit?: number };
    const userId = getAuthenticatedUserId(req);
    if (!sourcePodId || !query) return res.status(400).json({ error: 'sourcePodId and query are required' });
    const pod = await Pod.findById(sourcePodId).lean() as { members?: Array<{ userId?: { toString: () => string } }> } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const membership = pod.members?.find((m) => m.userId?.toString() === String(userId));
    if (!membership) return res.status(403).json({ error: 'Access denied' });
    const results = await FederationService.federatedSearch({ sourcePodId, query, queryTypes, actorId: userId, actorType: 'human', limit });
    return res.json({ results });
  } catch (error) {
    console.error('Error in federated search:', error);
    return res.status(500).json({ error: 'Failed to search' });
  }
});

router.get('/links/:linkId/audit', auth, async (req: Req, res: Res) => {
  try {
    const { linkId } = req.params || {};
    const { limit = '50' } = req.query || {};
    const userId = getAuthenticatedUserId(req);
    const link = await PodLink.findById(linkId).populate('auditLog.actorId', 'username').lean() as Record<string, unknown> | null;
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const sourcePod = await Pod.findById(link.sourcePodId).lean() as { members?: Array<{ userId?: { toString: () => string }; role?: string }> } | null;
    const membership = sourcePod?.members?.find((m) => m.userId?.toString() === String(userId));
    if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const auditLog = (link.auditLog as Array<{ action: string; actorId?: { _id?: { toString: () => string }; toString: () => string; username?: string }; actorType: string; timestamp: Date; details: unknown }>)
      .slice(-parseInt(limit, 10)).reverse()
      .map((entry) => ({ action: entry.action, actor: entry.actorId ? { id: entry.actorId._id?.toString() || entry.actorId.toString(), username: entry.actorId.username } : null, actorType: entry.actorType, timestamp: entry.timestamp, details: entry.details }));
    return res.json({ auditLog });
  } catch (error) {
    console.error('Error getting audit log:', error);
    return res.status(500).json({ error: 'Failed to get audit log' });
  }
});

module.exports = router;
