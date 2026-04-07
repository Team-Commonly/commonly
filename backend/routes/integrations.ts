// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const axios = require('axios');
import crypto from 'crypto';
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const adminAuth = require('../middleware/adminAuth');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const DiscordIntegration = require('../models/DiscordIntegration');
// eslint-disable-next-line global-require
const DiscordService = require('../services/discordService');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { buildCatalogEntries } = require('../integrations/catalog');
// eslint-disable-next-line global-require
const { manifests } = require('../integrations/manifests');
// eslint-disable-next-line global-require
const registry = require('../integrations');
// eslint-disable-next-line global-require
const { normalizeBufferMessage } = require('../integrations/normalizeBufferMessage');
// eslint-disable-next-line global-require
const { hash, randomSecret } = require('../utils/secret');

interface AuthReq {
  user?: { id: string; role?: string };
  integrationAuth?: boolean;
  integration?: Record<string, unknown>;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  header?: (name: string) => string | undefined;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

let validateRequiredConfig: (config: unknown, manifest: unknown) => void;
try {
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ validateRequiredConfig } = require('../../packages/integration-sdk/src/manifest'));
} catch (_err) {
  validateRequiredConfig = (config: unknown, manifest: unknown) => {
    const m = manifest as { requiredConfig?: string[] };
    const required = m?.requiredConfig || [];
    const missing = required.filter((field) => {
      const c = config as Record<string, unknown>;
      const value = c?.[field];
      return value === undefined || value === null || value === '';
    });
    if (missing.length) {
      const error = Object.assign(new Error(`Missing fields: ${missing.join(', ')}`), { missing });
      throw error;
    }
  };
}

const router: ReturnType<typeof express.Router> = express.Router();

const resolveEffectiveConfig = (type: string, config: Record<string, unknown> = {}) => {
  if (type !== 'discord') return config;
  return { ...config, botToken: config.botToken || process.env.DISCORD_BOT_TOKEN };
};

const getMissingRequiredFields = (type: string, config: unknown): string[] => {
  const manifest = (manifests as Record<string, { requiredConfig?: string[] }>)[type];
  if (!manifest?.requiredConfig?.length) return [];
  const effectiveConfig = resolveEffectiveConfig(type, config as Record<string, unknown>);
  return manifest.requiredConfig.filter((field) => {
    const value = (effectiveConfig as Record<string, unknown>)?.[field];
    return value === undefined || value === null || value === '';
  });
};

const isManifestComplete = (type: string, config: unknown) => getMissingRequiredFields(type, config).length === 0;

const validateManifestIfComplete = (type: string, config: unknown) => {
  const manifest = (manifests as Record<string, unknown>)[type];
  if (!manifest || !isManifestComplete(type, config)) return;
  validateRequiredConfig(resolveEffectiveConfig(type, config as Record<string, unknown>), manifest);
};

async function canDeleteIntegration(integration: { createdBy?: { toString: () => string }; podId?: unknown } | null, userId: string): Promise<boolean> {
  const user = await User.findById(userId) as { role?: string } | null;
  if (!user) return false;
  if (user.role === 'admin') return true;
  const pod = await Pod.findById(integration?.podId) as { createdBy?: { toString: () => string } } | null;
  if (pod && pod.createdBy?.toString() === userId) return true;
  if (integration?.createdBy?.toString() === userId) return true;
  return false;
}

const extractToken = (req: AuthReq) => {
  const authHeader = req.header?.('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.replace('Bearer ', '').trim();
  return req.header?.('x-commonly-integration-token');
};

const ingestAuth = async (req: AuthReq, res: Res, next: () => void) => {
  const token = extractToken(req);
  if (token && token.startsWith('cm_int_')) {
    const tokenHash = hash(token);
    const integration = await Integration.findOne({ 'ingestTokens.tokenHash': tokenHash }) as Record<string, unknown> | null;
    if (!integration) return res.status(401).json({ message: 'Invalid integration token' });
    try {
      await Integration.updateOne({ _id: integration._id, 'ingestTokens.tokenHash': tokenHash }, { $set: { 'ingestTokens.$.lastUsedAt': new Date() } });
    } catch (err) {
      console.warn('Failed to update integration token usage:', (err as Error).message);
    }
    req.integrationAuth = true;
    req.integration = integration;
    return next();
  }
  return auth(req, res, next);
};

router.get('/catalog', auth, async (req: AuthReq, res: Res) => {
  try {
    const entries = await buildCatalogEntries({ userId: req.user?.id });
    res.json({ entries });
  } catch (error) {
    console.error('Error fetching integration catalog:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/ingest', ingestAuth, async (req: AuthReq, res: Res) => {
  try {
    const { provider, integrationId, event, messages } = (req.body || {}) as { provider?: string; integrationId?: string; event?: unknown; messages?: unknown[] };
    const { integration: tokenIntegration } = req;
    let integration = tokenIntegration as Record<string, unknown> | null | undefined;
    if (!integrationId && !integration) return res.status(400).json({ message: 'integrationId is required' });
    if (!integration) integration = await Integration.findById(integrationId).lean();
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    if (integrationId && (integration._id as { toString: () => string }).toString() !== integrationId.toString()) return res.status(400).json({ message: 'integrationId does not match token' });
    const providerName = provider || (integration.type as string);
    if (providerName !== integration.type) return res.status(400).json({ message: 'Provider does not match integration type' });
    let normalizedMessages: unknown[] = [];
    if (Array.isArray(messages) && messages.length > 0) {
      normalizedMessages = messages;
    } else if (event) {
      let providerInstance: { ingestEvent: (e: unknown) => Promise<unknown[]> };
      try { providerInstance = registry.get(providerName, integration); }
      catch (_err) { return res.status(400).json({ message: 'Provider not registered' }); }
      normalizedMessages = await providerInstance.ingestEvent(event);
    } else {
      return res.status(400).json({ message: 'event or messages is required' });
    }
    const bufferMessages = (normalizedMessages || []).map(normalizeBufferMessage).filter(Boolean);
    if (bufferMessages.length === 0) return res.json({ success: true, count: 0 });
    const maxBufferSize = (integration.config as { maxBufferSize?: number })?.maxBufferSize || 1000;
    await Integration.findByIdAndUpdate(integration._id, { $push: { 'config.messageBuffer': { $each: bufferMessages, $slice: -1 * maxBufferSize } } });
    res.json({ success: true, count: bufferMessages.length });
  } catch (error) {
    console.error('Error ingesting integration event:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/ingest-tokens', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const { label } = (req.body || {}) as { label?: string };
    const integration = await Integration.findById(id) as { _id: unknown; createdBy?: { toString: () => string }; podId?: unknown; ingestTokens?: Array<unknown>; save: () => Promise<void> } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const canUpdate = await canDeleteIntegration(integration, req.user?.id || '');
    if (!canUpdate) return res.status(403).json({ message: 'Not authorized' });
    const token = `cm_int_${randomSecret(16)}`;
    const tokenHash = hash(token);
    integration.ingestTokens = integration.ingestTokens || [];
    integration.ingestTokens.push({ tokenHash, label: label || '', createdBy: req.user?.id, createdAt: new Date() });
    await integration.save();
    res.json({ token });
  } catch (error) {
    console.error('Error issuing ingest token:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/ingest-tokens', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const integration = await Integration.findById(id) as { createdBy?: { toString: () => string }; podId?: unknown; ingestTokens?: Array<{ _id: { toString: () => string }; label?: string; createdAt?: Date; lastUsedAt?: Date; createdBy?: unknown }> } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const canUpdate = await canDeleteIntegration(integration, req.user?.id || '');
    if (!canUpdate) return res.status(403).json({ message: 'Not authorized' });
    const tokens = (integration.ingestTokens || []).map((token) => ({ id: token._id.toString(), label: token.label, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt, createdBy: token.createdBy }));
    res.json({ tokens });
  } catch (error) {
    console.error('Error listing ingest tokens:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id/ingest-tokens/:tokenId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id, tokenId } = req.params || {};
    const integration = await Integration.findById(id) as { createdBy?: { toString: () => string }; podId?: unknown; ingestTokens?: Array<{ _id: { toString: () => string } }>; save: () => Promise<void> } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const canUpdate = await canDeleteIntegration(integration, req.user?.id || '');
    if (!canUpdate) return res.status(403).json({ message: 'Not authorized' });
    const before = integration.ingestTokens?.length || 0;
    integration.ingestTokens = (integration.ingestTokens || []).filter((token) => token._id.toString() !== tokenId);
    if ((integration.ingestTokens || []).length === before) return res.status(404).json({ message: 'Token not found' });
    await integration.save();
    res.json({ success: true });
  } catch (error) {
    console.error('Error revoking ingest token:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const integrations = await Integration.find({ podId, isActive: true }).populate('createdBy', 'username email').populate('platformIntegration');
    res.json(integrations);
  } catch (error) {
    console.error('Error fetching integrations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, type, config } = (req.body || {}) as { podId?: string; type?: string; config?: Record<string, unknown> };
    if (!podId || !type || !config) return res.status(400).json({ message: 'Missing required fields' });
    const manifest = (manifests as Record<string, unknown>)[type];
    if (!manifest) return res.status(400).json({ message: 'Unsupported integration type' });
    const nextConfig = { ...config };
    if (type === 'telegram' && !nextConfig.connectCode) nextConfig.connectCode = crypto.randomBytes(3).toString('hex');
    const missingRequired = getMissingRequiredFields(type, nextConfig);
    if (type === 'discord' && missingRequired.length) return res.status(400).json({ message: `Missing required fields: ${missingRequired.join(', ')}`, missing: missingRequired });
    if (missingRequired.length && (req.body as { status?: string })?.status === 'connected') return res.status(400).json({ message: `Missing required fields: ${missingRequired.join(', ')}`, missing: missingRequired });
    validateManifestIfComplete(type, nextConfig);
    const integration = new Integration({ podId, type, config: nextConfig, createdBy: req.user?.id, status: 'pending' });
    await integration.save();
    let platformIntegration = null;
    if (type === 'discord') {
      const webhookResponse = await axios.post(`https://discord.com/api/channels/${config.channelId}/webhooks`, { name: 'Commonly Bot', avatar: null }, { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } });
      const webhook = webhookResponse.data as { id: string; token: string };
      platformIntegration = new DiscordIntegration({ integrationId: integration._id, serverId: config.serverId, serverName: config.serverName, channelId: config.channelId, channelName: config.channelName, webhookUrl: `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`, webhookId: webhook.id, botToken: process.env.DISCORD_BOT_TOKEN, permissions: config.permissions || ['read_messages', 'send_messages'] });
      await platformIntegration.save();
    } else if (['slack', 'groupme', 'telegram', 'messenger', 'whatsapp', 'x', 'instagram'].includes(type)) {
      integration.status = isManifestComplete(type, nextConfig) ? 'connected' : 'pending';
      await integration.save();
    } else {
      return res.status(400).json({ message: 'Unsupported integration type' });
    }
    if (type === 'discord') {
      const service = new DiscordService(integration._id);
      const initialized = await service.initialize();
      if (!initialized) return res.status(500).json({ message: 'Failed to initialize integration' });
      const connected = await service.connect();
      if (!connected) console.warn('Integration initialized but failed to connect');
    }
    res.status(201).json({ integration, platformIntegration });
  } catch (error) {
    console.error('Error creating integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/connect', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const integration = await Integration.findById(id) as { type?: string; podId?: unknown } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const pod = await Pod.findById(integration.podId) as { createdBy?: { toString: () => string } } | null;
    if (!pod || pod.createdBy?.toString() !== req.user?.id) return res.status(403).json({ message: 'Access denied' });
    let service: { connect: () => Promise<boolean> } | null = null;
    if (integration.type === 'discord') service = new DiscordService(id);
    else if (integration.type !== 'slack') return res.status(400).json({ message: 'Unsupported integration type' });
    const connected = service ? await service.connect() : true;
    if (connected) res.json({ message: 'Integration connected successfully' });
    else res.status(500).json({ message: 'Failed to connect integration' });
  } catch (error) {
    console.error('Error connecting integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/disconnect', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const integration = await Integration.findById(id) as { type?: string; podId?: unknown } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const pod = await Pod.findById(integration.podId) as { createdBy?: { toString: () => string } } | null;
    if (!pod || pod.createdBy?.toString() !== req.user?.id) return res.status(403).json({ message: 'Access denied' });
    if (integration.type !== 'discord') return res.status(400).json({ message: 'Unsupported integration type' });
    const service = new DiscordService(id);
    const disconnected = await service.disconnect();
    if (disconnected) res.json({ message: 'Integration disconnected successfully' });
    else res.status(500).json({ message: 'Failed to disconnect integration' });
  } catch (error) {
    console.error('Error disconnecting integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/stats', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const integration = await Integration.findById(id) as { type?: string; podId?: unknown } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const pod = await Pod.findById(integration.podId) as { createdBy?: { toString: () => string } } | null;
    if (!pod || pod.createdBy?.toString() !== req.user?.id) return res.status(403).json({ message: 'Access denied' });
    let service: { getStats: () => Promise<unknown> } | null = null;
    if (integration.type === 'discord') service = new DiscordService(id);
    else if (integration.type !== 'slack') return res.status(400).json({ message: 'Unsupported integration type' });
    const stats = service ? await service.getStats() : { connected: true };
    res.json(stats);
  } catch (error) {
    console.error('Error getting integration stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/messages', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const { limit, before } = req.query || {};
    const integration = await Integration.findById(id) as { type?: string; podId?: unknown } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const pod = await Pod.findById(integration.podId) as { createdBy?: { toString: () => string } } | null;
    if (!pod || pod.createdBy?.toString() !== req.user?.id) return res.status(403).json({ message: 'Access denied' });
    if (integration.type === 'discord') {
      const service = new DiscordService(id);
      const messages = await service.fetchMessages({ limit, before });
      return res.json(messages);
    }
    if (integration.type === 'slack') return res.json({ messages: [] });
    return res.status(400).json({ message: 'Unsupported integration type' });
  } catch (error) {
    console.error('Error fetching integration messages:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/send', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const { message } = (req.body || {}) as { message?: string };
    const integration = await Integration.findById(id) as { type?: string; podId?: unknown } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const pod = await Pod.findById(integration.podId) as { createdBy?: { toString: () => string } } | null;
    if (!pod || pod.createdBy?.toString() !== req.user?.id) return res.status(403).json({ message: 'Access denied' });
    if (integration.type === 'discord') {
      const service = new DiscordService(id);
      const result = await service.sendMessage(message);
      return res.json({ success: true, result });
    }
    if (integration.type === 'slack') return res.json({ success: true, result: 'not-implemented' });
    return res.status(400).json({ message: 'Unsupported integration type' });
  } catch (error) {
    console.error('Error sending message through integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/admin/all', auth, adminAuth, async (_req: AuthReq, res: Res) => {
  try {
    const integrations = await Integration.find({ isActive: true }).populate('podId', 'name type createdBy').populate('createdBy', 'username email').populate('platformIntegration').sort({ createdAt: -1 });
    res.json(integrations);
  } catch (error) {
    console.error('Error fetching all integrations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/user/all', auth, async (req: AuthReq, res: Res) => {
  try {
    const integrations = await Integration.find({ createdBy: req.user?.id, isActive: true }).populate('podId', 'name type').populate('platformIntegration').sort({ createdAt: -1 });
    res.json(integrations);
  } catch (error) {
    console.error('Error fetching user integrations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/:id', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const { config, status, isActive } = (req.body || {}) as { config?: Record<string, unknown>; status?: string; isActive?: boolean };
    const integration = await Integration.findById(id) as { type?: string; createdBy?: { toString: () => string }; podId?: unknown; config?: { toObject?: () => Record<string, unknown> } } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const canUpdate = await canDeleteIntegration(integration, req.user?.id || '');
    if (!canUpdate) return res.status(403).json({ message: 'Access denied' });
    const currentConfig = integration.config?.toObject ? integration.config.toObject() : (integration.config || {}) as Record<string, unknown>;
    const nextConfig = config ? { ...currentConfig, ...config } : currentConfig;
    const missingRequired = getMissingRequiredFields(integration.type || '', nextConfig);
    if (missingRequired.length && status === 'connected') return res.status(400).json({ message: `Missing required fields: ${missingRequired.join(', ')}`, missing: missingRequired });
    validateManifestIfComplete(integration.type || '', nextConfig);
    const update: Record<string, unknown> = {};
    if (config) update.config = nextConfig;
    if (typeof status === 'string') update.status = status;
    if (typeof isActive === 'boolean') update.isActive = isActive;
    const autoStatusTypes = ['groupme', 'telegram', 'slack', 'x', 'instagram'];
    if (autoStatusTypes.includes(integration.type || '') && config) {
      update.status = (update.status as string | undefined) || (isManifestComplete(integration.type || '', nextConfig) ? 'connected' : 'pending');
    }
    const updated = await Integration.findByIdAndUpdate(id, update, { new: true });
    return res.json(updated);
  } catch (error) {
    console.error('Error updating integration:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', auth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const integration = await Integration.findById(id) as { type?: string; createdBy?: { toString: () => string }; podId?: unknown } | null;
    if (!integration) return res.status(404).json({ message: 'Integration not found' });
    const canDelete = await canDeleteIntegration(integration, req.user?.id || '');
    if (!canDelete) return res.status(403).json({ message: 'Access denied' });
    const service = integration.type === 'discord' ? new DiscordService(id) : null;
    try { if (service) await service.disconnect(); } catch (error) { console.warn('Error disconnecting service during deletion:', error); }
    if (integration.type === 'discord') await DiscordIntegration.findOneAndDelete({ integrationId: id });
    await Integration.findByIdAndDelete(id);
    res.json({ message: 'Integration deleted successfully' });
  } catch (error) {
    console.error('Error deleting integration:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
