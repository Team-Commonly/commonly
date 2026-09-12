// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const rateLimit = require('express-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const registry = require('../../integrations');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const {
  WEBHOOK_DELIVERY_TTL_MS,
  claimDelivery,
  releaseDelivery,
} = require('../../services/webhookDeliveryService');
const { verifySlackSignature: verifySlackRequestSignature } = require('../../services/webhookVerificationService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { relaySlackMessageToPod } = require('../../services/slackBridgeService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { cloudflareIpRateLimitKeyGenerator } = require('../../middleware/ipRateLimit');

const router = express.Router({ mergeParams: true });
const PROVIDER = 'slack';

// Slack retries delivery aggressively, so this budget deliberately leaves
// room for a busy shared workspace while still bounding unauthenticated work
// before HMAC verification and receipt creation.
const slackWebhookRateLimit = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: (_req: unknown, res: any) => res.status(429).json({ error: 'Too many Slack webhook requests' }),
});

const header = (req: any, name: string): string => String(req.get?.(name) || req.headers?.[name.toLowerCase()] || '');

export const verifySlackSignature = (req: any, now = Date.now()): boolean => {
  const timestamp = header(req, 'x-slack-request-timestamp');
  const signature = header(req, 'x-slack-signature');
  // server.ts captures rawBody before JSON/form parsing. The fallback makes
  // the narrow unit router testable; production never signs a reserialized body.
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
  return verifySlackRequestSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp,
    signature,
    rawBody,
    now,
  });
};

const signed = (req: any, res: any, next: () => void) => {
  if (!verifySlackSignature(req)) return res.status(401).json({ error: 'Invalid Slack signature' });
  return next();
};

const finishEvent = async (deliveryId: string, teamId: string, event: any): Promise<void> => {
  try {
    // Keep provider input scalar before it reaches Mongoose. The direct
    // String/strip form is intentionally adjacent to the selector so both
    // the runtime boundary and CodeQL's NoSQL-injection model see the fence.
    const safeTeamId = String(teamId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const channelId = String(event?.channel || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeTeamId || !channelId) {
      return;
    }
    const integration = await Integration.findOne({
      type: 'slack',
      isActive: true,
      'config.teamId': safeTeamId,
      'config.chatId': channelId,
      'config.chatType': 'im',
      'config.liveRelay': true,
      'config.adminPause': { $exists: false },
      status: { $ne: 'error' },
    }).lean();
    if (integration) await relaySlackMessageToPod({ integration, event });
  } catch (error) {
    console.error('[slack-events] processing failed:', (error as Error).message);
    await releaseDelivery(PROVIDER, deliveryId);
  }
};

/**
 * Installable Slack Events API endpoint. It is intentionally separate from
 * the legacy /:integrationId provider route below: one Slack app has one
 * global request URL and resolves its target by team + DM channel.
 */
router.post('/events', slackWebhookRateLimit, signed, async (req: any, res: any) => {
  const body = req.body || {};
  if (body.type === 'url_verification') return res.status(200).json({ challenge: body.challenge });
  const event = body.event;
  if (!event || event.type !== 'message') return res.status(200).json({ ok: true });
  if (!body.event_id) return res.status(400).json({ error: 'Missing Slack event id' });
  // D8/private-chat gate in Slack spelling. Do this before a DB lookup or a
  // receipt: group/channel traffic must not create either side effect.
  if (event.channel_type !== 'im' || event.subtype) return res.status(200).json({ ok: true });
  const teamId = String(body.team_id || event.team || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!teamId) return res.status(400).json({ error: 'Missing Slack team id' });
  const eventId = String(body.event_id);
  const deliveryId = `${teamId}:${eventId}`;
  let claimed: string;
  try {
    claimed = await claimDelivery(PROVIDER, deliveryId, WEBHOOK_DELIVERY_TTL_MS);
  } catch (error) {
    // claimDelivery normally degrades to an unclaimed delivery when Mongo is
    // unavailable; retain a defensive 503 if a replacement store throws.
    console.error('[slack-events] delivery claim failed:', (error as Error).message);
    return res.status(503).json({ error: 'Slack event delivery unavailable' });
  }
  if (claimed !== 'claimed') return res.status(200).json({ ok: true });
  // Ack before the bridge's database/PG work. Slack's 3s deadline is a
  // transport concern; WebhookDelivery carries the work claim.
  res.status(200).json({ ok: true });
  setImmediate(() => { void finishEvent(deliveryId, teamId, event); });
  return undefined;
});

const commandHelp = 'Use /commonly status, mode mirror|attention, mute [minutes], or unmute.';

router.post('/commands', slackWebhookRateLimit, signed, async (req: any, res: any) => {
  const body = req.body || {};
  const teamId = String(body.team_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const channelId = String(body.channel_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const slackUserId = String(body.user_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!teamId || !channelId || !slackUserId) {
    return res.status(400).json({ response_type: 'ephemeral', text: 'Invalid Slack command context.' });
  }
  const integration = await Integration.findOne({
    type: 'slack',
    isActive: true,
    'config.teamId': teamId,
    'config.chatId': channelId,
    'config.chatType': 'im',
    'config.slackUserId': slackUserId,
    'config.adminPause': { $exists: false },
    status: { $ne: 'error' },
  });
  if (!integration) {
    return res.status(404).json({
      response_type: 'ephemeral',
      text: 'This Slack DM is not connected to Commonly.',
    });
  }
  const [command, argument] = String(body.text || '').trim().split(/\s+/, 2);
  const normalized = command?.toLowerCase() || 'help';
  if (normalized === 'mode') {
    if (argument !== 'mirror' && argument !== 'attention') {
      return res.json({ response_type: 'ephemeral', text: 'Usage: /commonly mode mirror|attention' });
    }
    await Integration.updateOne(
      { _id: integration._id },
      { $set: { 'config.relayAllAgentMessages': argument === 'mirror' } },
    );
    return res.json({ response_type: 'ephemeral', text: `Relay mode: ${argument}.` });
  }
  if (normalized === 'mute') {
    const minutes = Math.min(Math.max(parseInt(argument || '60', 10) || 60, 1), 24 * 60);
    await Integration.updateOne(
      { _id: integration._id },
      { $set: { 'config.relayMutedUntil': new Date(Date.now() + minutes * 60_000) } },
    );
    return res.json({ response_type: 'ephemeral', text: `Muted for ${minutes} minutes.` });
  }
  if (normalized === 'unmute') {
    await Integration.updateOne({ _id: integration._id }, { $unset: { 'config.relayMutedUntil': 1 } });
    return res.json({ response_type: 'ephemeral', text: 'Relay unmuted.' });
  }
  if (normalized === 'status') {
    const mode = integration.config?.relayAllAgentMessages ? 'mirror' : 'attention';
    return res.json({ response_type: 'ephemeral', text: `Relay is ${mode}.` });
  }
  return res.json({ response_type: 'ephemeral', text: commandHelp });
});

// Legacy per-row Slack integrations preserve their old provider path. It is
// intentionally last so /events and /commands cannot be swallowed as an id.
router.post('/:integrationId', slackWebhookRateLimit, async (req: any, res: any) => {
  let deliveryId: string | null = null;
  try {
    const { integrationId } = req.params;
    const integration = await Integration.findById(integrationId);
    if (!integration || integration.type !== 'slack') {
      return res.status(404).json({ error: 'Integration not found' });
    }

    const body = req.body || {};
    const signingSecret = integration.config?.signingSecret || process.env.SLACK_SIGNING_SECRET;
    const timestamp = header(req, 'x-slack-request-timestamp');
    const signature = header(req, 'x-slack-signature');
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(body);
    if (!verifySlackRequestSignature({ signingSecret, timestamp, signature, rawBody })) {
      return res.status(401).json({ error: 'Invalid Slack signature' });
    }
    const eventId = body.event_id || body.event?.event_id || body.event?.ts || body.ts;
    if (!eventId) return res.status(400).json({ error: 'Missing Slack event id' });
    const teamId = String(body.team_id || body.event?.team || integration.config?.teamId || 'legacy')
      .replace(/[^a-zA-Z0-9_-]/g, '');
    deliveryId = `${teamId}:${String(eventId)}`;
    if ((await claimDelivery(PROVIDER, deliveryId, WEBHOOK_DELIVERY_TTL_MS)) !== 'claimed') {
      return res.sendStatus(200);
    }
    const provider = registry.get('slack', integration);
    const { events } = provider.getWebhookHandlers();
    try {
      return await events(req, res);
    } catch (error) {
      await releaseDelivery(PROVIDER, deliveryId);
      deliveryId = null;
      throw error;
    }
  } catch (error) {
    if (deliveryId) await releaseDelivery(PROVIDER, deliveryId);
    console.error('Slack webhook error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.verifySlackSignature = verifySlackSignature;

export {};
