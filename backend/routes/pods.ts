import path from 'path';
import fs from 'fs';
// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const multer = require('multer');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const { getAllPods, getPodsByType, getPodById, createPod, joinPod, leavePod, removeMember, deletePod } = require('../controllers/podController');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const Announcement = require('../models/Announcement');
// eslint-disable-next-line global-require
const ExternalLink = require('../models/ExternalLink');
// eslint-disable-next-line global-require
const PodContextService = require('../services/podContextService');
// eslint-disable-next-line global-require
const PodMemorySearchService = require('../services/podMemorySearchService');

interface AuthReq {
  user?: { id: string };
  userId?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  file?: { path: string };
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
  sendFile: (path: string) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const storage = multer.diskStorage({
  destination: (req: unknown, file: unknown, cb: (err: Error | null, dir: string) => void) => {
    const uploadDir = 'uploads/qrcodes';
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req: unknown, file: { originalname: string }, cb: (err: Error | null, name: string) => void) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `qrcode-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req: unknown, file: { mimetype: string }, cb: (err: Error | null, accept?: boolean) => void) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

router.get('/', auth, getAllPods);
router.post('/', auth, createPod);

router.post('/announcement', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, title, content } = (req.body || {}) as { podId?: string; title?: string; content?: string };
    if (!podId || !title || !content) return res.status(400).json({ message: 'Missing required fields' });
    const pod = await Pod.findById(podId) as { createdBy?: { toString: () => string }; announcements?: unknown[]; save: () => Promise<void> } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    if (pod.createdBy?.toString() !== req.user?.id) return res.status(403).json({ message: 'Only pod owner can create announcements' });
    const announcement = new Announcement({ podId, title, content, createdBy: req.user?.id });
    await announcement.save();
    pod.announcements?.push(announcement._id);
    await pod.save();
    return res.status(201).json(announcement);
  } catch (error) {
    console.error('Error creating announcement:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/announcement/:id', auth, async (req: AuthReq, res: Res) => {
  try {
    const announcementId = req.params?.id;
    const announcement = await Announcement.findById(announcementId) as { podId?: unknown; deleteOne?: () => Promise<void> } | null;
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    const pod = await Pod.findById(announcement.podId) as { createdBy?: { toString: () => string }; announcements?: Array<{ toString: () => string }>; save: () => Promise<void> } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    if (pod.createdBy?.toString() !== req.user?.id) return res.status(403).json({ message: 'Only pod owner can delete announcements' });
    pod.announcements = pod.announcements?.filter((id) => id.toString() !== announcementId);
    await pod.save();
    await Announcement.findByIdAndDelete(announcementId);
    return res.status(200).json({ message: 'Announcement deleted successfully' });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/external-link', auth, upload.single('qrCode'), async (req: AuthReq, res: Res) => {
  try {
    const { podId, name, type, url } = (req.body || {}) as { podId?: string; name?: string; type?: string; url?: string };
    if (!podId || !name || !type) return res.status(400).json({ message: 'Missing required fields' });
    const pod = await Pod.findById(podId) as { createdBy?: { toString: () => string }; externalLinks?: unknown[]; save: () => Promise<void> } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    if (pod.createdBy?.toString() !== req.user?.id) return res.status(403).json({ message: 'Only pod owner can add external links' });
    const externalLink = new ExternalLink({ podId, name, type, createdBy: req.user?.id });
    if (type === 'wechat' && req.file) externalLink.qrCodePath = req.file.path;
    else if (url) externalLink.url = url;
    else return res.status(400).json({ message: 'URL or QR code is required' });
    await externalLink.save();
    pod.externalLinks?.push(externalLink._id);
    await pod.save();
    return res.status(201).json(externalLink);
  } catch (error) {
    console.error('Error creating external link:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/external-link/:id', auth, async (req: AuthReq, res: Res) => {
  try {
    const linkId = req.params?.id;
    const externalLink = await ExternalLink.findById(linkId) as { podId?: unknown; qrCodePath?: string } | null;
    if (!externalLink) return res.status(404).json({ message: 'External link not found' });
    const pod = await Pod.findById(externalLink.podId) as { createdBy?: { toString: () => string }; externalLinks?: Array<{ toString: () => string }>; save: () => Promise<void> } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    if (pod.createdBy?.toString() !== req.user?.id) return res.status(403).json({ message: 'Only pod owner can delete external links' });
    pod.externalLinks = pod.externalLinks?.filter((id) => id.toString() !== linkId);
    await pod.save();
    if (externalLink.qrCodePath && fs.existsSync(externalLink.qrCodePath)) fs.unlinkSync(externalLink.qrCodePath);
    await ExternalLink.findByIdAndDelete(linkId);
    return res.status(200).json({ message: 'External link deleted successfully' });
  } catch (error) {
    console.error('Error deleting external link:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/external-link/:linkId/qrcode', auth, async (req: AuthReq, res: Res) => {
  try {
    const { linkId } = req.params || {};
    const link = await ExternalLink.findById(linkId) as { type?: string; qrCodePath?: string; podId?: unknown } | null;
    if (!link || link.type !== 'wechat' || !link.qrCodePath) return res.status(404).json({ message: 'QR code not found' });
    const pod = await Pod.findById(link.podId) as { members?: Array<{ toString: () => string }> } | null;
    if (!pod || !pod.members?.some((m) => m.toString() === req.user?.id)) return res.status(403).json({ message: 'Access denied' });
    return res.sendFile(path.resolve(link.qrCodePath));
  } catch (error) {
    console.error('Error fetching QR code:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const parseLimit = (raw: string | undefined, fallback: number, max: number) => {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isNaN(parsed) ? fallback : clamp(parsed, 1, max);
};
const parseBool = (value: string | undefined) => String(value).toLowerCase() === 'true';

router.get('/:id/context/search', auth, async (req: AuthReq, res: Res) => {
  const userId = req.user?.id || req.userId;
  const podId = req.params?.id;
  const query = req.query?.query || req.query?.q || '';
  const types = typeof req.query?.types === 'string' ? req.query.types.split(',').map((t) => t.trim()).filter(Boolean) : [];
  if (!String(query).trim()) return res.status(400).json({ message: 'query is required' });
  try {
    const results = await PodMemorySearchService.searchPodMemory({ podId, userId, query, limit: parseLimit(req.query?.limit, 8, 40), includeSkills: parseBool(req.query?.includeSkills), types });
    return res.status(200).json(results);
  } catch (error) {
    const e = error as { status?: number; message?: string; code?: string };
    if (e?.status) return res.status(e.status).json({ message: e.message, code: e.code });
    console.error('Error searching pod memory:', error);
    return res.status(500).json({ message: 'Failed to search pod memory' });
  }
});

router.get('/:id/context/assets/:assetId', auth, async (req: AuthReq, res: Res) => {
  const userId = req.user?.id || req.userId;
  const { id: podId, assetId } = req.params || {};
  try {
    const excerpt = await PodMemorySearchService.getAssetExcerpt({ podId, userId, assetId, from: parseLimit(req.query?.from, 1, 10000), lines: parseLimit(req.query?.lines, 12, 100) });
    return res.status(200).json(excerpt);
  } catch (error) {
    const e = error as { status?: number; message?: string; code?: string };
    if (e?.status) return res.status(e.status).json({ message: e.message, code: e.code });
    console.error('Error reading pod asset excerpt:', error);
    return res.status(500).json({ message: 'Failed to read pod asset' });
  }
});

router.get('/:id/context', auth, async (req: AuthReq, res: Res) => {
  const userId = req.user?.id || req.userId;
  const podId = req.params?.id;
  try {
    const context = await PodContextService.getPodContext({ podId, userId, task: req.query?.task || '', summaryLimit: parseLimit(req.query?.summaryLimit, 6, 20), assetLimit: parseLimit(req.query?.assetLimit, 12, 40), tagLimit: parseLimit(req.query?.tagLimit, 16, 40), skillLimit: parseLimit(req.query?.skillLimit, 6, 12), skillMode: typeof req.query?.skillMode === 'string' ? req.query.skillMode.toLowerCase() : 'llm', skillRefreshHours: parseLimit(req.query?.skillRefreshHours, 6, 72) });
    return res.status(200).json(context);
  } catch (error) {
    const e = error as { status?: number; message?: string; code?: string };
    if (e?.status) return res.status(e.status).json({ message: e.message, code: e.code });
    console.error('Error building pod context:', error);
    return res.status(500).json({ message: 'Failed to build pod context' });
  }
});

router.post('/:id/join', auth, joinPod);
router.post('/:id/leave', auth, leavePod);
router.delete('/:id/members/:memberId', auth, removeMember);

router.get('/:podId/announcements', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await Pod.findById(podId) as { members?: Array<{ toString: () => string }> } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    if (!pod.members?.some((member) => member.toString() === req.user?.id)) return res.status(403).json({ message: 'Not authorized to view pod announcements' });
    const announcements = await Announcement.find({ podId }).sort({ createdAt: -1 }).populate('createdBy', 'username profilePicture');
    return res.status(200).json(announcements);
  } catch (error) {
    console.error('Error retrieving pod announcements:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:podId/external-links', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await Pod.findById(podId) as Record<string, unknown> | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    const externalLinks = await ExternalLink.find({ podId }).sort({ createdAt: -1 }).populate('createdBy', 'username');
    return res.status(200).json(externalLinks);
  } catch (error) {
    console.error('Error fetching external links:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/children', auth, async (req: AuthReq, res: Res) => {
  try {
    const children = await Pod.find({ parentPod: req.params?.id }).populate('createdBy', 'username profilePicture').populate('members', 'username profilePicture').sort({ name: 1 });
    return res.json(children);
  } catch (err) {
    console.error('Error fetching child pods:', (err as Error).message);
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/:param', auth, async (req: AuthReq, res: Res) => {
  const { param } = req.params || {};
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(param || '');
  if (isObjectId) { req.params!.id = param || ''; return getPodById(req, res); }
  req.params!.type = param || '';
  return getPodsByType(req, res);
});

router.get('/:type/:id', auth, getPodById);
router.delete('/:id', auth, deletePod);

module.exports = router;
