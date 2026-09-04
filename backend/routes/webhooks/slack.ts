import { createHmac } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const express = require('express');
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

const router = express.Router({ mergeParams: true });
const SIGNATURE_WINDOW_MS = 5 * 60_000;

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
    const integration = await Integration.findOne({
      type: 'slack',
      isActive: true,
      'config.teamId': teamId,
      'config.chatId': event.channel,
      'config.chatType': 'im',
      'config.liveRelay': true,
    }).lean();
    if (integration) await relaySlackMessageToPod({ integration, event });
    await slackReceipts.markDone(eventId);
  } catch (error) {
    // Keep state=processing. A stale delivery can then be CAS-reclaimed by a
    // provider retry after a worker failure; done is reserved for a completed
    // or intentionally dropped event, never for an exception.
    console.error(`[slack-events] processing failed event=${eventId}:`, (error as Error).message);
  }
};

/**
 * Installable Slack Events API endpoint. It is intentionally separate from
 * the legacy /:integrationId provider route below: one Slack app has one
 * global request URL and resolves its target by team + DM channel.
 */
router.post('/events', signed, async (req: any, res: any) => {
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
  const teamId = String(body.team_id || event.team || '');
  setImmediate(() => { void finishEvent(String(body.event_id), teamId, event); });
  return undefined;
});

const commandHelp = 'Use /commonly status, mode mirror|attention, mute [minutes], or unmute.';

router.post('/commands', signed, async (req: any, res: any) => {
  const body = req.body || {};
  const integration = await Integration.findOne({
    type: 'slack',
    isActive: true,
    'config.teamId': body.team_id,
    'config.chatId': body.channel_id,
    'config.chatType': 'im',
    'config.slackUserId': body.user_id,
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
