import { createHmac } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const rateLimit = require('express-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const registry = require('../../integrations');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { safeEqual } = require('../../utils/secret');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const slackReceipts = require('../../services/slackEventReceiptService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { relaySlackMessageToPod } = require('../../services/slackBridgeService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { cloudflareIpRateLimitKeyGenerator } = require('../../middleware/ipRateLimit');

const router = express.Router({ mergeParams: true });
const SIGNATURE_WINDOW_MS = 5 * 60_000;

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
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const timestamp = header(req, 'x-slack-request-timestamp');
  const signature = header(req, 'x-slack-signature');
  if (!signingSecret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > SIGNATURE_WINDOW_MS) return false;
  // server.ts captures rawBody before JSON/form parsing. The fallback makes
  // the narrow unit router testable; production never signs a reserialized body.
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  return safeEqual(expected, signature);
};

const signed = (req: any, res: any, next: () => void) => {
  if (!verifySlackSignature(req)) return res.status(401).json({ error: 'Invalid Slack signature' });
  return next();
};

const finishEvent = async (eventId: string, teamId: string, event: any): Promise<void> => {
  try {
    // Keep provider input scalar before it reaches Mongoose. The direct
    // String/strip form is intentionally adjacent to the selector so both
    // the runtime boundary and CodeQL's NoSQL-injection model see the fence.
    const safeTeamId = String(teamId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const channelId = String(event?.channel || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeTeamId || !channelId) {
      await slackReceipts.markDone(eventId);
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
    await slackReceipts.markDone(eventId);
  } catch (error) {
    // Keep state=processing. A stale delivery can then be CAS-reclaimed by a
    // provider retry after a worker failure; done is reserved for a completed
    // or intentionally dropped event, never for an exception.
    console.error('[slack-events] processing failed:', (error as Error).message);
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
  if (!body.event_id || !event || event.type !== 'message') return res.status(200).json({ ok: true });
  // D8/private-chat gate in Slack spelling. Do this before a DB lookup or a
  // receipt: group/channel traffic must not create either side effect.
  if (event.channel_type !== 'im' || event.subtype) return res.status(200).json({ ok: true });
  let claimed: string;
  try {
    claimed = await slackReceipts.claim(String(body.event_id), String(body.team_id || event.team || ''));
  } catch (error) {
    // Do not manufacture duplicate pod authorship if the shared claim store is
    // down. A non-2xx asks Slack to redeliver once Mongo is reachable again.
    console.error('[slack-events] receipt claim failed:', (error as Error).message);
    return res.status(503).json({ error: 'Slack event receipt unavailable' });
  }
  if (claimed !== 'claimed') return res.status(200).json({ ok: true });
  // Ack before the bridge's database/PG work. Slack's 3s deadline is a
  // transport concern; state in SlackEventReceipt carries the work claim.
  res.status(200).json({ ok: true });
  const teamId = String(body.team_id || event.team || '').replace(/[^a-zA-Z0-9_-]/g, '');
  setImmediate(() => { void finishEvent(String(body.event_id), teamId, event); });
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
router.post('/:integrationId', async (req: any, res: any) => {
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
module.exports.verifySlackSignature = verifySlackSignature;

export {};
