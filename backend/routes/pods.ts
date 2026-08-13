import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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
const User = require('../models/User');
// eslint-disable-next-line global-require
const AuditLog = require('../models/AuditLog');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { NON_LISTABLE_POD_TYPES } = require('../services/podListing') as { NON_LISTABLE_POD_TYPES: readonly string[] };
// eslint-disable-next-line global-require
const DMService = require('../services/dmService');
// eslint-disable-next-line global-require
const Announcement = require('../models/Announcement');
// eslint-disable-next-line global-require
const ExternalLink = require('../models/ExternalLink');
// eslint-disable-next-line global-require
const File = require('../models/File');
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
  // Present on every express request; declared because the visibility route
  // records them on the AuditLog row that publishing a pod produces.
  ip?: string;
  headers?: Record<string, string | undefined>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
  sendFile: (path: string) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const podJoinRateLimitKey = (req: any) => {
  const authHeader = req.get?.('authorization') || req.get?.('x-auth-token');
  if (authHeader) {
    return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
  }
  return req.ip ? ipKeyGenerator(req.ip) : 'anon';
};

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

// Reject anything that isn't a real http(s) URL — guards against `javascript:`
// or `data:` schemes ending up in an <a href> in the inspector. WeChat QR-code
// links are exempt because their primary surface is qrCodePath, not href.
const isSafeHttpUrl = (rawUrl: string): boolean => {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

// URL → ExternalLinkType. Used when the client passes type='auto' (or omits
// type with a URL present) so the v2 inspector "+ Add" flow is paste-and-go.
// Match the most specific host first; everything unknown falls back to
// 'other_link'. Keep this in sync with the enum in models/ExternalLink.ts.
const detectLinkType = (rawUrl: string): string => {
  if (!rawUrl) return 'other_link';
  let host = '';
  let pathname = '';
  try {
    const u = new URL(rawUrl);
    host = u.hostname.toLowerCase();
    pathname = u.pathname.toLowerCase();
  } catch {
    return 'other_link';
  }
  if (host === 'notion.so' || host.endsWith('.notion.so') || host.endsWith('.notion.site')) return 'notion';
  if (host === 'docs.google.com') {
    if (pathname.includes('/document/')) return 'google_doc';
    if (pathname.includes('/spreadsheets/')) return 'google_sheet';
    if (pathname.includes('/presentation/')) return 'google_slides';
    return 'google_doc';
  }
  if (host === 'sheets.google.com') return 'google_sheet';
  if (host === 'slides.google.com') return 'google_slides';
  if (host === 'drive.google.com') return 'google_drive';
  if (host === 'figma.com' || host.endsWith('.figma.com')) return 'figma';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  if (host === 'mail.google.com') return 'gmail';
  if (host === 'github.com' || host.endsWith('.github.com')) {
    if (/\/pull\/\d+/.test(pathname)) return 'github_pr';
    if (/\/issues\/\d+/.test(pathname)) return 'github_issue';
    return 'github_repo';
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'loom.com' || host.endsWith('.loom.com')) return 'loom';
  if (host.includes('discord.com') || host.includes('discord.gg')) return 'discord';
  if (host === 't.me' || host.endsWith('.telegram.org')) return 'telegram';
  if (host.includes('groupme.com')) return 'groupme';
  return 'other_link';
};

const deriveLinkName = (rawUrl: string): string => {
  try {
    const u = new URL(rawUrl);
    const tail = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop();
    return tail ? `${u.hostname}${u.pathname.length > 1 ? ` · ${decodeURIComponent(tail).slice(0, 60)}` : ''}` : u.hostname;
  } catch {
    return rawUrl.slice(0, 80);
  }
};

router.post('/external-link', auth, upload.single('qrCode'), async (req: AuthReq, res: Res) => {
  try {
    const { podId, name: rawName, type: rawType, url } = (req.body || {}) as { podId?: string; name?: string; type?: string; url?: string };
    if (!podId) return res.status(400).json({ message: 'Missing podId' });
    // Auto-detect type when client passes 'auto' or no type with a URL — lets
    // the v2 inspector add-link flow work as a single paste field.
    const type = (!rawType || rawType === 'auto') && url ? detectLinkType(url) : rawType;
    if (!type) return res.status(400).json({ message: 'Missing type' });
    // Block javascript:/data: URLs before they reach the DB or the inspector
    // <a href> render path. WeChat is the only type that can ship without a
    // url (it carries qrCodePath instead).
    if (url && !isSafeHttpUrl(url)) return res.status(400).json({ message: 'URL must be http or https' });
    const name = (rawName && rawName.trim()) || (url ? deriveLinkName(url) : '');
    if (!name) return res.status(400).json({ message: 'Missing name' });
    const pod = await Pod.findById(podId) as { createdBy?: { toString: () => string }; members?: Array<{ toString: () => string }>; externalLinks?: unknown[]; save: () => Promise<void> } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    const userId = req.user?.id;
    const isOwner = pod.createdBy?.toString() === userId;
    const isMember = pod.members?.some((m) => m.toString() === userId);
    if (!isOwner && !isMember) return res.status(403).json({ message: 'Only pod members can add links' });
    const externalLink = new ExternalLink({ podId, name, type, createdBy: userId });
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

router.post('/:id/join', rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: podJoinRateLimitKey,
  handler: (_req: any, res: any) => res.status(429).json({ msg: 'rate limit exceeded: 20 pod joins per 60s' }),
}), auth, joinPod);
router.post('/:id/leave', auth, leavePod);
router.delete('/:id/members/:memberId', auth, removeMember);

// Pod admin actions hit Mongo on every call but don't need much volume.
// Capping per-IP keeps a stuck client from re-pinging contacts at full
// loop speed without adding code complexity.
const podAdminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * PATCH /api/pods/:id/contacts
 *
 * Pin (or clear) per-pod alias bindings — see ADR / agent-collaboration
 * plan §3.3. Body shape:
 *   { contacts: { codex: { agentName, instanceId } | null, ... } }
 *
 * Setting an alias to `null` removes the binding. Bindings live on
 * `pod.contacts` (Map default empty, so existing pods read cleanly).
 *
 * Auth: pod creator OR global admin only. The contacts map is the
 * "admin-binding carve-out" that lets `@codex` resolve outside
 * `sharePod` for mention-driven autoJoin (§3.4). Member-only writes
 * would let any pod member autoJoin an arbitrary agent in their own
 * contact list — a member-scoped pin trivially defeats the
 * co-pod-member rule. Reviewer 2baa52d266 flagged this; fix here.
 */
router.patch('/:id/contacts', podAdminRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const { id: podId } = req.params || {};
    const userId = req.user?.id;
    if (!podId) return res.status(400).json({ message: 'pod id is required' });
    const pod = await Pod.findById(podId) as {
      members?: Array<{ toString: () => string }>;
      contacts?: Map<string, unknown>;
      createdBy?: { toString: () => string };
      save: () => Promise<unknown>;
    } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    const isCreator = pod.createdBy && userId && pod.createdBy.toString() === String(userId);
    let isGlobalAdmin = false;
    if (!isCreator && userId) {
      const userRow = await User.findById(userId).select('role').lean() as { role?: string } | null;
      isGlobalAdmin = userRow?.role === 'admin';
    }
    if (!isCreator && !isGlobalAdmin) {
      return res.status(403).json({
        message: 'Only the pod creator or a global admin may edit pod contacts',
      });
    }

    const incoming = (req.body && typeof req.body.contacts === 'object' && req.body.contacts) || {};
    if (!pod.contacts) pod.contacts = new Map();

    for (const [rawAlias, binding] of Object.entries(incoming)) {
      const alias = String(rawAlias || '').trim().toLowerCase();
      if (!alias) continue;
      if (binding === null) {
        pod.contacts.delete(alias);
        continue;
      }
      const b = binding as { agentName?: unknown; instanceId?: unknown };
      const agentName = String(b.agentName || '').trim().toLowerCase();
      const instanceId = String(b.instanceId || 'default').trim();
      if (!agentName) {
        return res.status(400).json({ message: `contacts.${alias}.agentName is required` });
      }
      pod.contacts.set(alias, { agentName, instanceId });
    }

    await pod.save();
    const flattened: Record<string, { agentName: string; instanceId: string }> = {};
    pod.contacts.forEach((value, key) => {
      flattened[key] = value as { agentName: string; instanceId: string };
    });
    return res.status(200).json({ contacts: flattened });
  } catch (error) {
    console.error('Error updating pod contacts:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /:podId/agent-states — #891 surface 1, the mention-time honesty read.
 * Thin shell: membership gate + two fetches; the per-runtime-class honesty
 * rules (and the owner-only fix-copy split) live in agentStateService, where
 * they are pure and unit-tested.
 */
const agentStatesRateLimit = rateLimit({
  windowMs: 60 * 1000,
  // The composer polls at 60s per open pod, so even a user with several pods
  // open sits far under this; the ceiling exists for runaway tabs and scripts.
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

router.get('/:podId/agent-states', agentStatesRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await Pod.findById(podId) as { type?: string } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    const canView = await DMService.canViewPod(req.user?.id, pod);
    if (!canView) return res.status(403).json({ message: 'Not authorized to view pod agent states' });

    // eslint-disable-next-line global-require
    const { AgentInstallation } = require('../models/AgentRegistry');
    // eslint-disable-next-line global-require
    const AgentIdentityService = require('../services/agentIdentityService');
    // eslint-disable-next-line global-require
    const { deriveAgentState } = require('../services/agentStateService');

    const installations = await AgentInstallation.find({ podId, status: 'active' })
      .select('agentName instanceId displayName installedBy config runtimeTokens')
      .lean();
    if (!installations.length) return res.json({ agents: [] });

    const identityFilters = installations.map((inst: any) => ({
      'botMetadata.agentName': AgentIdentityService.resolveAgentType(String(inst.agentName || '').toLowerCase()),
      'botMetadata.instanceId': String(inst.instanceId || 'default'),
    }));
    const agentUsers = await User.find({ isBot: true, $or: identityFilters })
      .select('botMetadata.agentName botMetadata.instanceId agentRuntimeTokens.lastUsedAt')
      .lean();
    const userTokensByIdentity = new Map<string, Array<{ lastUsedAt?: Date }>>();
    (agentUsers || []).forEach((u: any) => {
      const key = `${String(u.botMetadata?.agentName || '').toLowerCase()}:${String(u.botMetadata?.instanceId || 'default').toLowerCase()}`;
      userTokensByIdentity.set(key, u.agentRuntimeTokens || []);
    });

    const callerId = String(req.user?.id || '');
    const agents = installations.map((inst: any) => deriveAgentState(
      inst,
      userTokensByIdentity.get(
        `${AgentIdentityService.resolveAgentType(String(inst.agentName || '').toLowerCase())}:${String(inst.instanceId || 'default').toLowerCase()}`,
      ) || [],
      callerId,
    ));

    return res.json({ agents });
  } catch (error) {
    console.error('Error deriving pod agent states:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:podId/announcements', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await Pod.findById(podId) as { type?: string; members?: Array<{ toString: () => string }> } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    const canView = await DMService.canViewPod(req.user?.id, pod);
    if (!canView) return res.status(403).json({ message: 'Not authorized to view pod announcements' });
    const announcements = await Announcement.find({ podId }).sort({ createdAt: -1 }).populate('createdBy', 'username profilePicture');
    return res.status(200).json(announcements);
  } catch (error) {
    console.error('Error retrieving pod announcements:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:podId/files', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await Pod.findById(podId) as { type?: string; members?: Array<{ toString: () => string }> } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    const canView = await DMService.canViewPod(req.user?.id, pod);
    if (!canView) return res.status(403).json({ message: 'Not authorized to view pod files' });
    // Most recent 100 — file lists in the inspector are bounded by what the
    // user can scan visually; pagination can come later if pods get heavy.
    const files = await File.find({ podId })
      .sort({ createdAt: -1 })
      .limit(100)
      .select('fileName originalName contentType size uploadedBy createdAt')
      .populate('uploadedBy', 'username profilePicture');
    return res.status(200).json(files);
  } catch (error) {
    console.error('Error fetching pod files:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:podId/external-links', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await Pod.findById(podId) as { type?: string; members?: Array<{ toString: () => string }> } | null;
    if (!pod) return res.status(404).json({ message: 'Pod not found' });
    // Parity with /announcements and /files above — external-links are
    // pod-scoped artifacts and must respect the same visibility rule, not
    // be openly readable by any authenticated user.
    const canView = await DMService.canViewPod(req.user?.id, pod);
    if (!canView) return res.status(403).json({ message: 'Not authorized to view pod external links' });
    const externalLinks = await ExternalLink.find({ podId }).sort({ createdAt: -1 }).populate('createdBy', 'username');
    return res.status(200).json(externalLinks);
  } catch (error) {
    console.error('Error fetching external links:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/children', auth, async (req: AuthReq, res: Res) => {
  try {
    const parentId = req.params?.id || '';
    // Children listing reveals pod existence + names + members under a
    // parent. Gate by the parent's visibility so a non-member can't
    // enumerate someone else's nested workspace structure. The full
    // results array is then filtered to children the caller can also
    // see — matches the principle from PR #375 (no leak via fan-out
    // queries either).
    const parent = await Pod.findById(parentId).select('_id members type').lean();
    if (!parent) return res.status(404).json({ msg: 'Pod not found' });
    const canViewParent = await DMService.canViewPod(req.user?.id, parent);
    if (!canViewParent) return res.status(403).json({ msg: 'Not authorized to view child pods' });
    const children = await Pod.find({ parentPod: parentId })
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .sort({ name: 1 });
    const visibleChildren = [];
    for (const child of children) {
      // eslint-disable-next-line no-await-in-loop
      if (await DMService.canViewPod(req.user?.id, child)) visibleChildren.push(child);
    }
    return res.json(visibleChildren);
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

// Promoting a room to Community makes it world-readable AND discoverable, so
// it is rate-limited harder than ordinary pod admin actions: this is the one
// owner-writable control that publishes content to people who are not members
// and do not have an account.
const podVisibilityRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * POST /api/pods/:id/visibility  { tier: 'private' | 'community' }
 *
 * ADR-016's ordered tier (private -> showcase -> community), owner-writable
 * for the two ends. Before this, `communityListed` was settable ONLY from
 * `routes/admin/pods.ts` behind adminAuth, which made the creation flow's most
 * prominent choice inert for every non-admin: a user picking "Open to join"
 * got `joinPolicy: 'open'` on a pod nobody could find, because
 * `self-joinable <=> community AND open` and they could not reach community
 * (#768).
 *
 * ONE ATOMIC WRITE, both flags together — deliberately, and not the admin
 * route's two steps. The admin surface separates them because `showcase`
 * (publicRead without listing) is a real curated state it needs to express.
 * An owner cannot reach that state: `showcase` is admin-only, so an owner-side
 * two-step would 409 on `listing_requires_public_read` forever with no way to
 * clear it. Writing the pair together is also what ADR-016 invariant 1
 * (listed => readable) asks of any writer that can prove it.
 *
 * Deliberately NOT exposed to agents: this is a `dualAuth`-free human route.
 * An agent that could publish its own pod could exfiltrate a private room's
 * entire future history with one call.
 */
router.post('/:id/visibility', podVisibilityRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = req.userId || (req as unknown as { user?: { id?: string } }).user?.id;
    const { tier } = (req.body || {}) as { tier?: string };

    if (tier !== 'private' && tier !== 'community') {
      return res.status(400).json({
        error: 'invalid_tier',
        // `showcase` is intentionally absent: it publishes every future
        // message to anonymous readers and stays an audited admin action.
        message: "tier must be 'private' or 'community'",
      });
    }

    const podId = req.params?.id;
    if (!podId) return res.status(400).json({ error: 'Pod id is required' });

    const pod = await Pod.findById(podId) as {
      _id: { toString: () => string };
      type?: string;
      publicRead?: boolean;
      communityListed?: boolean;
      createdBy?: { toString: () => string };
      save: () => Promise<unknown>;
    } | null;
    if (!pod) return res.status(404).json({ error: 'Pod not found' });

    const isCreator = pod.createdBy && userId && pod.createdBy.toString() === String(userId);
    const actor = userId
      ? await User.findById(userId).select('role entitlements').lean() as {
        role?: string; entitlements?: { pro?: boolean };
      } | null
      : null;
    const isGlobalAdmin = actor?.role === 'admin';
    if (!isCreator && !isGlobalAdmin) {
      return res.status(403).json({
        error: 'not_pod_owner',
        message: 'Only the pod creator or a global admin may change pod visibility',
      });
    }

    // Listing to Community is a paid capability. Gated on the entitlement
    // rather than on payment state directly, so the check stays identical
    // however billing is wired later (today an admin sets the flag, same shape
    // as the invite-code path for cloudAgents).
    //
    // DEMOTION IS NEVER GATED. A user whose subscription lapses must always be
    // able to make their own room private again — paywalling the exit turns a
    // billing event into an unwanted permanent disclosure.
    if (tier === 'community' && !isGlobalAdmin && actor?.entitlements?.pro !== true) {
      return res.status(402).json({
        error: 'pro_required',
        message: 'Listing a pod in Community is part of the paid plan. '
          + 'Your pod stays private and everything already in it is unaffected.',
      });
    }

    // DM kinds are terminally private (ADR-001 s3.10 / ADR-016 invariant 3).
    // Guarded here as well as at the admin writer because this is now a
    // second door into the same flags.
    if (NON_LISTABLE_POD_TYPES.includes(String(pod.type))) {
      return res.status(400).json({
        error: 'pod_type_not_listable',
        message: `Cannot change Community visibility for a personal pod type (${pod.type})`,
      });
    }

    const listed = tier === 'community';
    pod.publicRead = listed;
    pod.communityListed = listed;
    await pod.save();

    try {
      await AuditLog.create({
        action: listed ? 'community.list' : 'community.unlist',
        target: pod._id.toString(),
        detail: `tier=${tier} publicRead=${listed} communityListed=${listed} type=${pod.type} via=owner`,
        userId,
        ip: req.ip,
        userAgent: req.headers?.['user-agent'],
      });
    } catch (auditErr) {
      console.warn('[pods] visibility audit log write failed (non-fatal):', (auditErr as Error).message);
    }

    return res.json({
      id: pod._id.toString(),
      tier,
      publicRead: pod.publicRead,
      communityListed: pod.communityListed,
    });
  } catch (err) {
    console.error('[pods] visibility change error:', (err as Error).message);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.get('/:type/:id', auth, getPodById);
router.delete('/:id', auth, deletePod);

module.exports = router;
