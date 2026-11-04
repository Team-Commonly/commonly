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
import { applyRelayCommand } from '../../services/chatRelay/chatRelayCore';
import type { RelayCommand, RelayCommandOutcome } from '../../services/chatRelay/chatRelayCore';

const router = express.Router({ mergeParams: true });
const PROVIDER = 'slack';

// Keep a coarse source-IP ceiling before the account bucket. The team id in a
// request body is sender-controlled until HMAC verification, so it cannot be
// the only abuse key.
const slackWebhookIpRateLimit = rateLimit({
  windowMs: 60_000,
  max: 3_000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => `slack-ip:${cloudflareIpRateLimitKeyGenerator(req)}`,
  handler: (_req: unknown, res: any) => res.status(429).json({ error: 'Too many Slack webhook requests from this IP' }),
});

// Slack retries delivery aggressively, so this account budget leaves room for
// a busy workspace while still bounding verified-account bursts.
const slackWebhookRateLimit = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => {
    const accountId = String(req.params?.integrationId || req.body?.team_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return accountId ? `slack:${accountId}` : `slack:${cloudflareIpRateLimitKeyGenerator(req)}`;
  },
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
  let relayStarted = false;
  try {
    // Keep provider input scalar before it reaches Mongoose. The direct
    // String/strip form is intentionally adjacent to the selector so both
    // the runtime boundary and CodeQL's NoSQL-injection model see the fence.
    const safeTeamId = String(teamId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const channelId = String(event?.channel || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeTeamId || !channelId) {
      return;
    }
    const integrations = await Integration.find({
      type: 'slack',
      isActive: true,
      'config.teamId': safeTeamId,
      'config.chatId': channelId,
      'config.chatType': 'im',
      'config.liveRelay': true,
      'config.adminPause': { $exists: false },
      status: { $ne: 'error' },
    }).limit(2).lean();
    if (integrations.length > 1) {
      console.error('[slack-events] ambiguous active DM binding:', safeTeamId, channelId);
      return;
    }
    const integration = integrations[0];
    if (integration) {
      relayStarted = true;
      await relaySlackMessageToPod({ integration, event });
    }
  } catch (error) {
    console.error('[slack-events] processing failed:', (error as Error).message);
    // Once relay starts it may already have written the pod message. Keep the
    // claim on every downstream throw; only pre-relay lookup failures are safe
    // to release for a provider retry.
    if (!relayStarted) {
      await releaseDelivery(PROVIDER, deliveryId);
    }
  }
};

/**
 * Installable Slack Events API endpoint. It is intentionally separate from
 * the legacy /:integrationId provider route below: one Slack app has one
 * global request URL and resolves its target by team + DM channel.
 */
router.post('/events', slackWebhookIpRateLimit, slackWebhookRateLimit, signed, async (req: any, res: any) => {
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
  if (claimed === 'unavailable') return res.status(503).json({ error: 'Slack event delivery unavailable' });
  if (claimed !== 'claimed') return res.status(200).json({ ok: true });
  // Ack before the bridge's database/PG work. Slack's 3s deadline is a
  // transport concern; WebhookDelivery carries the work claim.
  res.status(200).json({ ok: true });
  setImmediate(() => { void finishEvent(deliveryId, teamId, event); });
  return undefined;
});

const commandHelp = 'Use /commonly status, mode mirror|attention, mute [minutes], or unmute.';

// Slack's spelling of the shared bridge commands: one `/commonly` slash command
// with a subcommand. The subcommand is case-insensitive, the argument is taken
// as typed, and anything unrecognised — an empty text included — is help.
const parseSlackRelayCommand = (text: unknown): RelayCommand => {
  const [command, argument] = String(text || '').trim().split(/\s+/, 2);
  const normalized = command?.toLowerCase() || 'help';
  if (normalized === 'mode') return { name: 'mode', arg: argument };
  if (normalized === 'mute') return { name: 'mute', arg: argument };
  if (normalized === 'unmute') return { name: 'unmute' };
  if (normalized === 'status') return { name: 'status' };
  return { name: 'help' };
};

// The state change is the shared core's (applyRelayCommand); the words are
// Slack's. Slack has no bare `/commonly mode`, so a missing argument reads as
// usage rather than the current mode.
const slackCommandReply = (outcome: RelayCommandOutcome): string => {
  switch (outcome.kind) {
    case 'mode-show':
    case 'mode-usage':
      return 'Usage: /commonly mode mirror|attention';
    case 'mode-set':
      return `Relay mode: ${outcome.mode}.`;
    case 'mute':
      return `Muted for ${outcome.minutes} minutes.`;
    case 'unmute':
      return 'Relay unmuted.';
    case 'status':
      return `Relay is ${outcome.mode}.`;
    default:
      return commandHelp;
  }
};

router.post('/commands', slackWebhookIpRateLimit, slackWebhookRateLimit, signed, async (req: any, res: any) => {
  const body = req.body || {};
  const teamId = String(body.team_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const channelId = String(body.channel_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const slackUserId = String(body.user_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!teamId || !channelId || !slackUserId) {
    return res.status(400).json({ response_type: 'ephemeral', text: 'Invalid Slack command context.' });
  }
  const integrations = await Integration.find({
    type: 'slack',
    isActive: true,
    'config.teamId': teamId,
    'config.chatId': channelId,
    'config.chatType': 'im',
    'config.slackUserId': slackUserId,
    'config.adminPause': { $exists: false },
    status: { $ne: 'error' },
  }).limit(2).lean();
  if (integrations.length > 1) {
    return res.status(409).json({
      response_type: 'ephemeral',
      text: 'This Slack DM has more than one Commonly connection. Disconnect one in Commonly before using commands.',
    });
  }
  const integration = integrations[0];
  if (!integration) {
    return res.status(404).json({
      response_type: 'ephemeral',
      text: 'This Slack DM is not connected to Commonly.',
    });
  }
  const outcome = applyRelayCommand(parseSlackRelayCommand(body.text), integration);
  if ('update' in outcome) await Integration.updateOne({ _id: integration._id }, outcome.update);
  return res.json({ response_type: 'ephemeral', text: slackCommandReply(outcome) });
});

// Legacy per-row Slack integrations preserve their old provider path. It is
// intentionally last so /events and /commands cannot be swallowed as an id.
router.post('/:integrationId', slackWebhookIpRateLimit, slackWebhookRateLimit, async (req: any, res: any) => {
  let deliveryId: string | null = null;
  try {
    const { integrationId } = req.params;
    const integration = await Integration.findById(integrationId);
    // An inactive row answers like an unknown id. This route takes no auth, so a
    // row's own verification key would otherwise outlive the access that planted
    // it; `/events` resolves only `isActive` rows for the same reason (TASK-141).
    if (!integration || integration.type !== 'slack' || !integration.isActive) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    const body = req.body || {};
    // Env only: the instance's signing secret is the key Slack signs with, and a
    // row-supplied copy has had no writer since it joined
    // `SERVER_OWNED_CONFIG_KEYS` (TASK-141).
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    const timestamp = header(req, 'x-slack-request-timestamp');
    const signature = header(req, 'x-slack-signature');
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(body);
    if (!verifySlackRequestSignature({ signingSecret, timestamp, signature, rawBody })) {
      return res.status(401).json({ error: 'Invalid Slack signature' });
    }
    if (body.type === 'url_verification') {
      return res.status(200).json({ challenge: body.challenge });
    }
    const eventId = body.event_id || body.event?.event_id || body.event?.ts || body.ts;
    if (!eventId) return res.status(400).json({ error: 'Missing Slack event id' });
    const teamId = String(body.team_id || body.event?.team || integration.config?.teamId || 'legacy')
      .replace(/[^a-zA-Z0-9_-]/g, '');
    deliveryId = `${teamId}:${String(eventId)}`;
    const claim = await claimDelivery(PROVIDER, deliveryId, WEBHOOK_DELIVERY_TTL_MS);
    if (claim === 'unavailable') {
      return res.status(503).json({ error: 'Slack event delivery unavailable' });
    }
    if (claim !== 'claimed') {
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
