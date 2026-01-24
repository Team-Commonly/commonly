const express = require('express');
const Integration = require('../../models/Integration');
const registry = require('../../integrations');

const router = express.Router({ mergeParams: true });

// Slack sends JSON with signature based on raw body; raw middleware is set in server.js
router.post('/:integrationId', async (req, res) => {
  try {
    const { integrationId } = req.params;
    const integration = await Integration.findById(integrationId);
    if (!integration || integration.type !== 'slack') {
      return res.status(404).json({ error: 'Integration not found' });
    }
    const provider = registry.get('slack', integration);
    const { events } = provider.getWebhookHandlers();
    return events(req, res);
  } catch (error) {
    console.error('Slack webhook error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
