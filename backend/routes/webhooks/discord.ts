const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const DiscordService = require('../../services/discordService');
const DiscordIntegration = require('../../models/DiscordIntegration');
const {
  WEBHOOK_DELIVERY_TTL_MS,
  claimDelivery,
  releaseDelivery,
} = require('../../services/webhookDeliveryService');
const { verifyDiscordSignature } = require('../../services/webhookVerificationService');
const { cloudflareIpRateLimitKeyGenerator } = require('../../middleware/ipRateLimit');

// webhook_id is supplied by the caller before signature verification, so keep
// a coarse Cloudflare-aware IP ceiling ahead of the per-webhook bucket.
const discordWebhookIpRateLimit = rateLimit({
  windowMs: 60_000,
  max: 3_000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => `discord-ip:${cloudflareIpRateLimitKeyGenerator(req)}`,
  handler: (_req: unknown, res: any) => res.status(429).json({ error: 'Too many Discord webhook requests from this IP' }),
});

const discordWebhookRateLimit = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => {
    const webhookId = String(req.query?.webhook_id || req.headers?.['x-discord-webhook-id'] || '')
      .replace(/[^a-zA-Z0-9_-]/g, '');
    return webhookId ? `discord:${webhookId}` : `discord:${cloudflareIpRateLimitKeyGenerator(req)}`;
  },
  handler: (_req: unknown, res: any) => res.status(429).json({ error: 'Too many Discord webhook requests' }),
});

const header = (req: any, name: string): string => String(req.get?.(name) || req.headers?.[name.toLowerCase()] || '');

export const verifyDiscordWebhookRequest = (req: any): boolean => {
  if (process.env.DISCORD_WEBHOOK_ALLOW_UNVERIFIED === 'true') return true;
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
  return verifyDiscordSignature({
    publicKey: process.env.DISCORD_PUBLIC_KEY,
    timestamp: header(req, 'x-signature-timestamp'),
    signature: header(req, 'x-signature-ed25519'),
    rawBody,
  });
};

// Discord webhook endpoint
router.post('/', discordWebhookIpRateLimit, discordWebhookRateLimit, async (req: any, res: any) => {
  let deliveryId: string | null = null;
  try {
    const event = req.body;

    if (!event || typeof event !== 'object') {
      return res.status(400).json({ error: 'Invalid Discord event' });
    }

    if (!verifyDiscordWebhookRequest(req)) {
      return res.status(401).json({ error: 'Invalid Discord signature' });
    }

    // Handle Discord webhook verification
    if (event.type === 1) {
      // PING
      return res.json({ type: 1 }); // PONG
    }

    // Extract webhook ID from the request
    const webhookId = req.query.webhook_id || req.headers['x-discord-webhook-id'];

    if (!webhookId) {
      console.error('No webhook ID provided');
      return res.status(400).json({ error: 'Missing webhook ID' });
    }

    // Find the Discord integration by webhook ID
    const discordIntegration = await DiscordIntegration.findOne({
      webhookId,
      isActive: true,
    });

    if (!discordIntegration) {
      console.error('Discord integration not found for webhook ID:', webhookId);
      return res.status(404).json({ error: 'Integration not found' });
    }

    const eventId = event.id;
    if (!eventId) return res.status(400).json({ error: 'Missing Discord event id' });
    deliveryId = `${String(webhookId)}:${String(eventId)}`;
    const claim = await claimDelivery('discord', deliveryId, WEBHOOK_DELIVERY_TTL_MS);
    if (claim === 'unavailable') {
      return res.status(503).json({ error: 'Discord delivery unavailable' });
    }
    if (claim !== 'claimed') {
      return res.json({ success: true, duplicate: true });
    }

    // Create Discord service instance
    const service = new DiscordService(discordIntegration.integrationId);

    // Handle the webhook event
    try {
      await service.handleWebhook(event);
    } catch (error) {
      await releaseDelivery('discord', deliveryId);
      deliveryId = null;
      throw error;
    }

    res.json({ success: true });
  } catch (error) {
    if (deliveryId) await releaseDelivery('discord', deliveryId);
    console.error('Error handling Discord webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Discord-specific routes
router.get('/channels/:integrationId', async (req: any, res: any) => {
  try {
    const { integrationId } = req.params;

    const service = new DiscordService(integrationId);
    const channels = await service.getChannels();

    res.json(channels);
  } catch (error) {
    console.error('Error fetching Discord channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// Generate bot invite link
router.post('/invite', async (req: any, res: any) => {
  try {
    const { clientId, permissions, guildId } = req.body;

    if (!clientId) {
      return res.status(400).json({ error: 'Client ID is required' });
    }

    const baseUrl = 'https://discord.com/api/oauth2/authorize';
    const scopes = ['bot', 'applications.commands'];
    const botPermissions = permissions || '2048'; // Read Messages, Send Messages

    const inviteUrl = `${baseUrl}?client_id=${clientId}&scope=${scopes.join('%20')}&permissions=${botPermissions}${
      guildId ? `&guild_id=${guildId}` : ''
    }`;

    res.json({ inviteUrl });
  } catch (error) {
    console.error('Error generating invite link:', error);
    res.status(500).json({ error: 'Failed to generate invite link' });
  }
});

// Test webhook endpoint
router.post('/test/:integrationId', async (req: any, res: any) => {
  try {
    const { integrationId } = req.params;

    const service = new DiscordService(integrationId);
    const isConnected = await service.testConnection();

    if (isConnected) {
      res.json({
        success: true,
        message: 'Webhook connection test successful',
      });
    } else {
      res
        .status(400)
        .json({ success: false, message: 'Webhook connection test failed' });
    }
  } catch (error) {
    console.error('Error testing webhook:', error);
    res.status(500).json({ error: 'Failed to test webhook' });
  }
});

module.exports = router;
module.exports.verifyDiscordWebhookRequest = verifyDiscordWebhookRequest;
// LEGACY: in-platform webhook. External provider service will replace this route.

export {};
