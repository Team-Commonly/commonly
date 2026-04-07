import crypto from 'crypto';
// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const App = require('../models/App');
// eslint-disable-next-line global-require
const AppInstallation = require('../models/AppInstallation');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const AppService = require('../services/appService');
// eslint-disable-next-line global-require
const { hash, randomSecret } = require('../utils/secret');

interface AuthReq {
  user?: { id: string; role?: string };
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

const ensurePodAccess = async (podId: string, userId: unknown) => {
  const pod = await Pod.findById(podId).lean() as Record<string, unknown> & { createdBy?: { toString: () => string }; members?: Array<{ userId?: { toString: () => string }; toString: () => string }> } | null;
  if (!pod) {
    const error = new Error('Pod not found') as PodError;
    error.code = 'POD_NOT_FOUND';
    throw error;
  }
  const userIdStr = userId?.toString();
  const isCreator = pod.createdBy?.toString() === userIdStr;
  const isMember = pod.members?.some((m) => (m.userId?.toString() || m.toString()) === userIdStr);
  if (!isCreator && !isMember) {
    const error = new Error('Access denied') as PodError;
    error.code = 'POD_ACCESS_DENIED';
    throw error;
  }
  return pod;
};

router.get('/marketplace', async (req: AuthReq, res: Res) => {
  try {
    const { category, type, search, sort, limit, skip } = req.query || {};
    const apps = await AppService.getMarketplaceApps({ category, type, search, sort, limit: parseInt(limit || '50', 10) || 50, skip: parseInt(skip || '0', 10) || 0 });
    return res.json({ apps });
  } catch (error) {
    console.error('Error listing marketplace apps:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/marketplace/featured', async (req: AuthReq, res: Res) => {
  try {
    const limit = parseInt(req.query?.limit || '6', 10) || 6;
    const apps = await AppService.getFeaturedApps(limit);
    return res.json({ apps });
  } catch (error) {
    console.error('Error listing featured apps:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/marketplace/:id', async (req: AuthReq, res: Res) => {
  try {
    const app = await App.findOne({ _id: req.params?.id, 'marketplace.published': true, status: 'active' }).select('-clientSecretHash -webhookSecretHash');
    if (!app) return res.status(404).json({ error: 'App not found' });
    return res.json(AppService.formatForMarketplace(app));
  } catch (error) {
    console.error('Error getting marketplace app:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/pods/:podId/apps', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUserId(req);
    await ensurePodAccess(req.params?.podId || '', userId);
    const apps = await AppService.getInstalledApps(req.params?.podId);
    return res.json({ apps });
  } catch (error) {
    const e = error as PodError;
    console.error('Error listing installed apps:', error);
    if (e.code === 'POD_NOT_FOUND') return res.status(404).json({ error: e.message });
    if (e.code === 'POD_ACCESS_DENIED') return res.status(403).json({ error: e.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/pods/:podId/apps', auth, async (req: AuthReq, res: Res) => {
  try {
    const { appId, scopes, events, expiresIn } = (req.body || {}) as { appId?: string; scopes?: unknown; events?: unknown; expiresIn?: unknown };
    if (!appId) return res.status(400).json({ error: 'appId is required' });
    const userId = getUserId(req);
    await ensurePodAccess(req.params?.podId || '', userId);
    const result = await AppService.installApp(appId, req.params?.podId, userId, { scopes, events, expiresIn });
    return res.status(201).json(result);
  } catch (error) {
    const e = error as PodError;
    console.error('Error installing app:', error);
    if (e.message === 'App not found' || e.message === 'App is not active') return res.status(404).json({ error: e.message });
    if (e.message === 'App already installed') return res.status(409).json({ error: e.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/pods/:podId/apps/:installationId', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUserId(req);
    await ensurePodAccess(req.params?.podId || '', userId);
    const installation = await AppInstallation.findById(req.params?.installationId).lean() as { targetType?: string; targetId?: { toString: () => string } } | null;
    if (!installation) return res.status(404).json({ error: 'Installation not found' });
    if (installation.targetType !== 'pod' || installation.targetId?.toString() !== req.params?.podId) {
      return res.status(404).json({ error: 'Installation not found' });
    }
    await AppService.uninstallApp(req.params?.installationId, userId);
    return res.json({ success: true });
  } catch (error) {
    const e = error as PodError;
    console.error('Error uninstalling app:', error);
    if (e.code === 'POD_NOT_FOUND') return res.status(404).json({ error: e.message });
    if (e.code === 'POD_ACCESS_DENIED') return res.status(403).json({ error: e.message });
    if (e.message === 'Installation not found') return res.status(404).json({ error: e.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', auth, async (req: AuthReq, res: Res) => {
  try {
    const apps = await App.find({ ownerId: req.user?.id }).select('-clientSecretHash -webhookSecretHash').sort({ createdAt: -1 });
    return res.json(apps);
  } catch (error) {
    console.error('Error listing apps', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', auth, async (req: AuthReq, res: Res) => {
  try {
    const { name, description, homepage, callbackUrl, webhookUrl, allowedRedirects = [], defaultScopes = [], allowedEvents = [] } = (req.body || {}) as { name?: string; description?: string; homepage?: string; callbackUrl?: string; webhookUrl?: string; allowedRedirects?: unknown[]; defaultScopes?: unknown[]; allowedEvents?: unknown[] };
    if (!name || !webhookUrl) return res.status(400).json({ error: 'name and webhookUrl are required' });
    const clientId = randomSecret(16);
    const clientSecret = randomSecret();
    const webhookSecret = randomSecret();
    const app = await App.create({ name, description, homepage, callbackUrl, webhookUrl, clientId, clientSecretHash: hash(clientSecret), webhookSecretHash: hash(webhookSecret), ownerId: req.user?.id, allowedRedirects, defaultScopes, allowedEvents });
    return res.status(201).json({ appId: app._id, clientId, clientSecret, webhookSecret });
  } catch (error) {
    const e = error as Error;
    console.error('Error creating app', error);
    return res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'test' ? e.message : undefined });
  }
});

router.get('/:id', auth, async (req: AuthReq, res: Res) => {
  try {
    const app = await App.findById(req.params?.id) as { ownerId: { toString: () => string } } | null;
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (app.ownerId.toString() !== req.user?.id) return res.status(403).json({ error: 'Forbidden' });
    return res.json(app);
  } catch (error) {
    console.error('Error fetching app', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/rotate-secret', auth, async (req: AuthReq, res: Res) => {
  try {
    const app = await App.findById(req.params?.id) as { ownerId: { toString: () => string }; clientSecretHash: string; save: () => Promise<void> } | null;
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (app.ownerId.toString() !== req.user?.id) return res.status(403).json({ error: 'Forbidden' });
    const clientSecret = randomSecret();
    app.clientSecretHash = hash(clientSecret);
    await app.save();
    return res.json({ clientSecret });
  } catch (error) {
    console.error('Error rotating secret', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/installations', auth, async (req: AuthReq, res: Res) => {
  try {
    const { appId, targetType, targetId, scopes = [], events = [], expiresIn } = (req.body || {}) as { appId?: string; targetType?: string; targetId?: string; scopes?: unknown[]; events?: unknown[]; expiresIn?: number };
    if (!appId || !targetType || !targetId) return res.status(400).json({ error: 'appId, targetType, targetId required' });
    const app = await App.findById(appId) as { status: string } | null;
    if (!app) return res.status(404).json({ error: 'App not found' });
    if (app.status !== 'active') return res.status(400).json({ error: 'App disabled' });
    const token = randomSecret();
    const tokenHash = hash(token);
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    const installation = await AppInstallation.create({ appId, targetType, targetId, scopes, events, tokenHash, tokenExpiresAt, createdBy: req.user?.id });
    return res.status(201).json({ installationId: installation._id, token, tokenExpiresAt });
  } catch (error) {
    console.error('Error creating installation', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/installations/:id', auth, async (req: AuthReq, res: Res) => {
  try {
    const inst = await AppInstallation.findById(req.params?.id) as { createdBy: { toString: () => string }; appId: unknown; deleteOne: () => Promise<void> } | null;
    if (!inst) return res.status(404).json({ error: 'Not found' });
    const app = await App.findById(inst.appId) as { ownerId?: { toString: () => string } } | null;
    if (inst.createdBy.toString() !== req.user?.id && app?.ownerId?.toString() !== req.user?.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await inst.deleteOne();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting installation', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/webhook-test', auth, async (req: AuthReq, res: Res) => {
  try {
    const app = await App.findById(req.params?.id) as { ownerId: { toString: () => string } } | null;
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (app.ownerId.toString() !== req.user?.id) return res.status(403).json({ error: 'Forbidden' });
    const { webhookSecretOverride } = (req.body || {}) as { webhookSecretOverride?: string };
    if (!webhookSecretOverride) return res.status(400).json({ error: 'Provide webhookSecretOverride to sign payload' });
    const sample = { event: 'app.webhook.test', timestamp: new Date().toISOString() };
    const signature = crypto.createHmac('sha256', webhookSecretOverride).update(JSON.stringify(sample)).digest('hex');
    return res.json({ sample, signature });
  } catch (error) {
    console.error('Error running webhook test', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
