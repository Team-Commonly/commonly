const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const rateLimit = require('express-rate-limit');
const Integration = require('../../models/Integration');
const registry = require('../../integrations');
const {
  WEBHOOK_DELIVERY_TTL_MS,
  claimDelivery,
  releaseDelivery,
} = require('../../services/webhookDeliveryService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { cloudflareIpRateLimitKeyGenerator } = require('../../middleware/ipRateLimit');

const router = express.Router({ mergeParams: true });

const groupMeWebhookIpRateLimit = rateLimit({
  windowMs: 60_000,
  max: 3_000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => `groupme-ip:${cloudflareIpRateLimitKeyGenerator(req)}`,
  handler: (_req: unknown, res: any) => res.status(429).json({ error: 'Too many GroupMe webhook requests from this IP' }),
});

const groupMeWebhookRateLimit = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => {
    const integrationId = String(req.params?.integrationId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return integrationId ? `groupme:${integrationId}` : `groupme:${cloudflareIpRateLimitKeyGenerator(req)}`;
  },
  handler: (_req: unknown, res: any) => res.status(429).json({ error: 'Too many GroupMe webhook requests' }),
});

// GroupMe sends JSON via POST with bot_id, group_id, etc.
router.post('/:integrationId', groupMeWebhookIpRateLimit, groupMeWebhookRateLimit, async (req: any, res: any) => {
  let deliveryId: string | null = null;
  try {
    const { integrationId } = req.params;
    const integration = await Integration.findById(integrationId);
    if (!integration || integration.type !== 'groupme') {
      return res.status(404).json({ error: 'Integration not found' });
    }

    const body = req.body || {};
    const expectedBotId = String(integration.config?.botId || process.env.GROUPME_BOT_ID || '').trim();
    const actualBotId = String(body.bot_id || '').trim();
    const allowUnverified = process.env.GROUPME_WEBHOOK_ALLOW_UNVERIFIED === 'true';
    // GroupMe has no callback signature. The bot id is the provider's only
    // request-bound identity; an explicit local/dev escape hatch is required
    // before accepting a callback without it. A mismatched id is always
    // rejected because it proves this callback belongs to another bot.
    if (actualBotId && expectedBotId && actualBotId !== expectedBotId) {
      return res.status(401).send('invalid GroupMe bot identity');
    }
    if ((!expectedBotId || !actualBotId) && !allowUnverified) {
      return res.status(401).send('unverified GroupMe webhook');
    }
    const eventId = body.id;
    if (!eventId) return res.status(400).send('missing GroupMe message id');
    deliveryId = `${expectedBotId || actualBotId || 'unverified'}:${String(eventId)}`;
    const claim = await claimDelivery('groupme', deliveryId, WEBHOOK_DELIVERY_TTL_MS);
    if (claim === 'unavailable') {
      return res.status(503).json({ error: 'GroupMe delivery unavailable' });
    }
    if (claim !== 'claimed') {
      return res.sendStatus(200);
    }

    const provider = registry.get('groupme', integration);
    const { events } = provider.getWebhookHandlers();
    try {
      return await events(req, res);
    } catch (error) {
      await releaseDelivery('groupme', deliveryId);
      deliveryId = null;
      throw error;
    }
  } catch (error) {
    if (deliveryId) await releaseDelivery('groupme', deliveryId);
    console.error('GroupMe webhook error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
// LEGACY: in-platform webhook. External provider service will replace this route.

export {};
