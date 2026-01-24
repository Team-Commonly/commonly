const express = require('express');
const Integration = require('../../models/Integration');
const registry = require('../../integrations');

const router = express.Router({ mergeParams: true });

// Telegram sends JSON updates; we optionally verify secret token header
router.post('/:integrationId', async (req, res) => {
  try {
    const { integrationId } = req.params;
    const integration = await Integration.findById(integrationId);
    if (!integration || integration.type !== 'telegram') {
      return res.status(404).json({ error: 'Integration not found' });
    }
    const provider = registry.get('telegram', integration);
    const { events } = provider.getWebhookHandlers();
    return events(req, res);
  } catch (error) {
    console.error('Telegram webhook error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
