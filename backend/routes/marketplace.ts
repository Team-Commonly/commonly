// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const AgentManifest = require('../models/AgentManifest');

const router = express.Router();

interface ManifestBody {
  name?: string;
  slug?: string;
  version?: string;
  author?: string;
  runtimeType?: string;
  webhookUrl?: string;
  capabilities?: string[];
  isPublic?: boolean;
  [key: string]: any;
}

interface AuthReq {
  user?: { _id: any; id?: string; role?: string };
  userId?: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: ManifestBody;
}

interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

function validateManifestPayload(body: ManifestBody): string[] {
  const errors: string[] = [];
  const requiredFields = ['name', 'slug', 'version', 'author', 'runtimeType'];
  for (const field of requiredFields) {
    if (!body[field] || String(body[field]).trim() === '') {
      errors.push(`${field} is required`);
    }
  }
  if (body.runtimeType && !['webhook', 'moltbot', 'internal'].includes(body.runtimeType)) {
    errors.push('runtimeType is invalid');
  }
  if (body.webhookUrl && typeof body.webhookUrl !== 'string') {
    errors.push('webhookUrl must be a string');
  }
  if (body.capabilities && !Array.isArray(body.capabilities)) {
    errors.push('capabilities must be an array');
  }
  return errors;
}

router.get('/agents', async (_req: AuthReq, res: Res) => {
  const agents = await AgentManifest.find({ isPublic: true }).sort({ createdAt: -1 }).lean();
  res.json({ agents });
});

router.post('/agents/register', auth, async (req: AuthReq, res: Res) => {
  const errors = validateManifestPayload(req.body || {});
  if (errors.length) {
    return res.status(400).json({ message: 'Invalid manifest', errors });
  }

  try {
    const manifest = await AgentManifest.create({
      ...req.body,
      slug: String(req.body.slug).toLowerCase(),
      owner: req.user!._id,
      installedBy: req.user!._id,
      isPublic: Boolean(req.body.isPublic),
    });
    return res.status(201).json({ agent: manifest });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Slug already exists' });
    }
    throw error;
  }
});

router.get('/agents/:slug', async (req: AuthReq, res: Res) => {
  const agent = await AgentManifest.findOne({ slug: req.params.slug.toLowerCase() }).lean();
  if (!agent) {
    return res.status(404).json({ message: 'Agent not found' });
  }
  return res.json({ agent });
});

router.put('/agents/:slug', auth, async (req: AuthReq, res: Res) => {
  const agent = await AgentManifest.findOne({ slug: req.params.slug.toLowerCase() });
  if (!agent) {
    return res.status(404).json({ message: 'Agent not found' });
  }
  if (String(agent.owner) !== String(req.user!._id)) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const errors = validateManifestPayload({ ...agent.toObject(), ...req.body });
  if (errors.length) {
    return res.status(400).json({ message: 'Invalid manifest', errors });
  }

  Object.assign(agent, req.body, { slug: String(agent.slug).toLowerCase() });
  if (req.body.slug) agent.slug = String(req.body.slug).toLowerCase();
  await agent.save();
  return res.json({ agent });
});

module.exports = router;
