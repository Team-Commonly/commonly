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

// GroupMe callbacks are V3 messages. They carry group_id and id, but not the
// bot_id that is used by the outbound `/bots/post` API.
router.post('/:integrationId', groupMeWebhookIpRateLimit, groupMeWebhookRateLimit, async (req: any, res: any) => {
  let deliveryId: string | null = null;
  try {
    const { integrationId } = req.params;
    const integration = await Integration.findById(integrationId);
    if (!integration || integration.type !== 'groupme') {
      return res.status(404).json({ error: 'Integration not found' });
    }

    const body = req.body || {};
    const expectedGroupId = String(integration.config?.groupId || '').trim();
    const actualGroupId = String(body.group_id || '').trim();
    const allowUnverified = process.env.GROUPME_WEBHOOK_ALLOW_UNVERIFIED === 'true';
    // GroupMe has no callback signature. The callback's group_id is a routing
    // key, so require it to match this integration. This does not authenticate
    // the sender; a per-integration callback URL secret is a follow-up. The
    // bot_id belongs to the outbound API and is not present in V3 callbacks.
    if (actualGroupId && expectedGroupId && actualGroupId !== expectedGroupId) {
      return res.status(401).send('invalid GroupMe group');
    }
    if ((!expectedGroupId || !actualGroupId) && !allowUnverified) {
      return res.status(401).send('unverified GroupMe webhook');
    }
    const eventId = body.id;
    if (!eventId) return res.status(400).send('missing GroupMe message id');
    deliveryId = `${actualGroupId || expectedGroupId || 'unverified'}:${String(eventId)}`;
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
