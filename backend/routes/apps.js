const express = require('express');
const crypto = require('crypto');
const auth = require('../middleware/auth');
const App = require('../models/App');
const AppInstallation = require('../models/AppInstallation');
const Pod = require('../models/Pod');
const AppService = require('../services/appService');
const { hash, randomSecret } = require('../utils/secret');

const router = express.Router();

const getUserId = (req) => req.user?.id || req.user?._id || req.userId;

const ensurePodAccess = async (podId, userId) => {
  const pod = await Pod.findById(podId).lean();
  if (!pod) {
    const error = new Error('Pod not found');
    error.code = 'POD_NOT_FOUND';
    throw error;
  }

  const userIdStr = userId?.toString();
  const isCreator = pod.createdBy?.toString() === userIdStr;
  const isMember = pod.members?.some(
    (m) => (m.userId?.toString() || m.toString()) === userIdStr,
  );

  if (!isCreator && !isMember) {
    const error = new Error('Access denied');
    error.code = 'POD_ACCESS_DENIED';
    throw error;
  }

  return pod;
};

// ==========================================
// Marketplace Endpoints (Public)
// ==========================================

// List marketplace apps
router.get('/marketplace', async (req, res) => {
  try {
    const {
      category,
      type,
      search,
      sort,
      limit,
      skip,
    } = req.query;
    const apps = await AppService.getMarketplaceApps({
      category,
      type,
      search,
      sort,
      limit: parseInt(limit, 10) || 50,
      skip: parseInt(skip, 10) || 0,
    });
    return res.json({ apps });
  } catch (error) {
    console.error('Error listing marketplace apps:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get featured apps
router.get('/marketplace/featured', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 6;
    const apps = await AppService.getFeaturedApps(limit);
    return res.json({ apps });
  } catch (error) {
    console.error('Error listing featured apps:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get app details (public view)
router.get('/marketplace/:id', async (req, res) => {
  try {
    const app = await App.findOne({
      _id: req.params.id,
      'marketplace.published': true,
      status: 'active',
    }).select('-clientSecretHash -webhookSecretHash');

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    return res.json(AppService.formatForMarketplace(app));
  } catch (error) {
    console.error('Error getting marketplace app:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Pod Installation Endpoints
// ==========================================

// Get installed apps for a pod
router.get('/pods/:podId/apps', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    await ensurePodAccess(req.params.podId, userId);
    const apps = await AppService.getInstalledApps(req.params.podId);
    return res.json({ apps });
  } catch (error) {
    console.error('Error listing installed apps:', error);
    if (error.code === 'POD_NOT_FOUND') {
      return res.status(404).json({ error: error.message });
    }
    if (error.code === 'POD_ACCESS_DENIED') {
      return res.status(403).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Install an app to a pod
router.post('/pods/:podId/apps', auth, async (req, res) => {
  try {
    const {
      appId,
      scopes,
      events,
      expiresIn,
    } = req.body;
    if (!appId) {
      return res.status(400).json({ error: 'appId is required' });
    }

    const userId = getUserId(req);
    await ensurePodAccess(req.params.podId, userId);

    const result = await AppService.installApp(appId, req.params.podId, userId, {
      scopes,
      events,
      expiresIn,
    });

    return res.status(201).json(result);
  } catch (error) {
    console.error('Error installing app:', error);
    if (error.message === 'App not found' || error.message === 'App is not active') {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === 'App already installed') {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Uninstall an app from a pod
router.delete('/pods/:podId/apps/:installationId', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    await ensurePodAccess(req.params.podId, userId);

    const installation = await AppInstallation.findById(req.params.installationId).lean();
    if (!installation) {
      return res.status(404).json({ error: 'Installation not found' });
    }
    if (
      installation.targetType !== 'pod'
      || installation.targetId?.toString() !== req.params.podId
    ) {
      return res.status(404).json({ error: 'Installation not found' });
    }

    await AppService.uninstallApp(req.params.installationId, userId);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error uninstalling app:', error);
    if (error.code === 'POD_NOT_FOUND') {
      return res.status(404).json({ error: error.message });
    }
    if (error.code === 'POD_ACCESS_DENIED') {
      return res.status(403).json({ error: error.message });
    }
    if (error.message === 'Installation not found') {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Developer Endpoints
// ==========================================

// List apps for current user
router.get('/', auth, async (req, res) => {
  try {
    const apps = await App.find({ ownerId: req.user.id })
      .select('-clientSecretHash -webhookSecretHash')
      .sort({ createdAt: -1 });
    return res.json(apps);
  } catch (error) {
    console.error('Error listing apps', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Create an app (developer-owned)
router.post('/', auth, async (req, res) => {
  try {
    const {
      name,
      description,
      homepage,
      callbackUrl,
      webhookUrl,
      allowedRedirects = [],
      defaultScopes = [],
      allowedEvents = [],
    } = req.body;
    if (!name || !webhookUrl) {
      return res.status(400).json({ error: 'name and webhookUrl are required' });
    }

    const clientId = randomSecret(16);
    const clientSecret = randomSecret();
    const webhookSecret = randomSecret();

    const app = await App.create({
      name,
      description,
      homepage,
      callbackUrl,
      webhookUrl,
      clientId,
      clientSecretHash: hash(clientSecret),
      webhookSecretHash: hash(webhookSecret),
      ownerId: req.user.id,
      allowedRedirects,
      defaultScopes,
      allowedEvents,
    });

    return res.status(201).json({
      appId: app._id,
      clientId,
      clientSecret,
      webhookSecret,
    });
  } catch (error) {
    console.error('Error creating app', error);
    return res
      .status(500)
      .json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'test' ? error.message : undefined });
  }
});

// Get app (owner only)
router.get('/:id', auth, async (req, res) => {
  try {
    const app = await App.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (app.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json(app);
  } catch (error) {
    console.error('Error fetching app', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Rotate client secret
router.post('/:id/rotate-secret', auth, async (req, res) => {
  try {
    const app = await App.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (app.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const clientSecret = randomSecret();
    app.clientSecretHash = hash(clientSecret);
    await app.save();
    return res.json({ clientSecret });
  } catch (error) {
    console.error('Error rotating secret', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Create installation (consent assumed handled upstream)
router.post('/installations', auth, async (req, res) => {
  try {
    const {
      appId,
      targetType,
      targetId,
      scopes = [],
      events = [],
      expiresIn,
    } = req.body;
    if (!appId || !targetType || !targetId) {
      return res.status(400).json({ error: 'appId, targetType, targetId required' });
    }
    const app = await App.findById(appId);
    if (!app) return res.status(404).json({ error: 'App not found' });
    if (app.status !== 'active') return res.status(400).json({ error: 'App disabled' });

    const token = randomSecret();
    const tokenHash = hash(token);
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    const installation = await AppInstallation.create({
      appId,
      targetType,
      targetId,
      scopes,
      events,
      tokenHash,
      tokenExpiresAt,
      createdBy: req.user.id,
    });

    return res.status(201).json({ installationId: installation._id, token, tokenExpiresAt });
  } catch (error) {
    console.error('Error creating installation', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete installation
router.delete('/installations/:id', auth, async (req, res) => {
  try {
    const inst = await AppInstallation.findById(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    // allow owner of app or creator to delete
    const app = await App.findById(inst.appId);
    if (inst.createdBy.toString() !== req.user.id && app?.ownerId?.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await inst.deleteOne();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting installation', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Webhook test: send signed sample payload back to caller (for dev use)
router.post('/:id/webhook-test', auth, async (req, res) => {
  try {
    const app = await App.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (app.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const sample = { event: 'app.webhook.test', timestamp: new Date().toISOString() };
    const secretToUse = req.body.webhookSecretOverride || null;
    const signingSecret = secretToUse || null;
    if (!secretToUse) {
      return res.status(400).json({ error: 'Provide webhookSecretOverride to sign payload' });
    }
    const signature = crypto
      .createHmac('sha256', signingSecret)
      .update(JSON.stringify(sample))
      .digest('hex');
    return res.json({ sample, signature });
  } catch (error) {
    console.error('Error running webhook test', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
