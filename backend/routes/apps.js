const express = require('express');
const crypto = require('crypto');
const auth = require('../middleware/auth');
const App = require('../models/App');
const AppInstallation = require('../models/AppInstallation');
const { hash, randomSecret } = require('../utils/secret');

const router = express.Router();

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
