// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const adminAuth = require('../middleware/adminAuth');
// eslint-disable-next-line global-require
const Gateway = require('../models/Gateway');
// eslint-disable-next-line global-require
const { getOpenClawConfigPath } = require('../services/agentProvisionerService');
// eslint-disable-next-line global-require
const k8sGatewayProvisioner = require('../services/gatewayProvisionerServiceK8s');

interface AuthReq {
  userId?: string;
  user?: { id?: string; _id?: unknown };
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const slugify = (value: unknown): string => String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
const getUserId = (req: AuthReq): unknown => req.userId || req.user?.id || req.user?._id;

const ensureDefaultGateway = async (userId: unknown) => {
  const existing = await Gateway.findOne({ slug: 'default' });
  if (existing) return existing;
  const configPath = getOpenClawConfigPath();
  return Gateway.create({ name: 'Local Gateway', slug: 'default', type: 'openclaw', mode: 'local', configPath: configPath || '', status: 'active', createdBy: userId || undefined });
};

router.get('/', auth, adminAuth, async (req: AuthReq, res: Res) => {
  try {
    await ensureDefaultGateway(getUserId(req));
    const gateways = await Gateway.find().sort({ createdAt: 1 }).lean();
    return res.json({ gateways });
  } catch (error) {
    console.error('Error listing gateways:', error);
    return res.status(500).json({ error: 'Failed to list gateways' });
  }
});

router.post('/', auth, adminAuth, async (req: AuthReq, res: Res) => {
  try {
    const { name, slug, type = 'openclaw', mode = 'local', baseUrl = '', configPath = '', status = 'active', metadata = {} } = (req.body || {}) as { name?: string; slug?: string; type?: string; mode?: string; baseUrl?: string; configPath?: string; status?: string; metadata?: Record<string, unknown> };
    if (!name) return res.status(400).json({ error: 'name is required' });
    const resolvedSlug = slugify(slug || name);
    if (!resolvedSlug) return res.status(400).json({ error: 'slug is required' });
    const existing = await Gateway.findOne({ slug: resolvedSlug });
    if (existing) return res.status(400).json({ error: 'slug already exists' });
    const gateway = await Gateway.create({ name, slug: resolvedSlug, type, mode, baseUrl, configPath, status, metadata, createdBy: getUserId(req) });
    if (mode === 'k8s') {
      const gatewayToken = k8sGatewayProvisioner.generateGatewayToken();
      try {
        const provisioned = await k8sGatewayProvisioner.provisionGateway({ gateway, token: gatewayToken }) as { baseUrl?: string; namespace?: string; service?: string; deployment?: string };
        const updates = { baseUrl: gateway.baseUrl || provisioned.baseUrl, metadata: { ...(gateway.metadata || {}), namespace: provisioned.namespace, service: provisioned.service, deployment: provisioned.deployment } };
        const updatedGateway = await Gateway.findByIdAndUpdate(gateway._id, updates, { new: true });
        return res.status(201).json({ gateway: updatedGateway, gatewayToken });
      } catch (error) {
        await gateway.deleteOne();
        throw error;
      }
    }
    return res.status(201).json({ gateway });
  } catch (error) {
    console.error('Error creating gateway:', error);
    return res.status(500).json({ error: 'Failed to create gateway' });
  }
});

router.patch('/:id', auth, adminAuth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const updates = { ...(req.body || {}) } as Record<string, unknown>;
    if (updates.slug) updates.slug = slugify(updates.slug);
    const gateway = await Gateway.findByIdAndUpdate(id, updates, { new: true }) as Record<string, unknown> & { mode?: string; baseUrl?: string; metadata?: Record<string, unknown>; _id?: unknown; slug?: string } | null;
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    if (gateway.mode === 'k8s') {
      const provisioned = await k8sGatewayProvisioner.provisionGateway({ gateway, token: (updates?.metadata as Record<string, unknown>)?.gatewayToken }) as { baseUrl?: string; namespace?: string; service?: string; deployment?: string };
      const updated = await Gateway.findByIdAndUpdate(gateway._id, { baseUrl: gateway.baseUrl || provisioned.baseUrl, metadata: { ...(gateway.metadata || {}), namespace: provisioned.namespace, service: provisioned.service, deployment: provisioned.deployment } }, { new: true });
      return res.json({ gateway: updated });
    }
    return res.json({ gateway });
  } catch (error) {
    console.error('Error updating gateway:', error);
    return res.status(500).json({ error: 'Failed to update gateway' });
  }
});

router.delete('/:id', auth, adminAuth, async (req: AuthReq, res: Res) => {
  try {
    const { id } = req.params || {};
    const gateway = await Gateway.findById(id) as Record<string, unknown> & { slug?: string; mode?: string; deleteOne: () => Promise<void> } | null;
    if (!gateway) return res.status(404).json({ error: 'Gateway not found' });
    if (gateway.slug === 'default') return res.status(400).json({ error: 'Default gateway cannot be removed' });
    if (gateway.mode === 'k8s') await k8sGatewayProvisioner.deleteGateway({ gateway });
    await gateway.deleteOne();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting gateway:', error);
    return res.status(500).json({ error: 'Failed to delete gateway' });
  }
});

module.exports = router;

export {};
