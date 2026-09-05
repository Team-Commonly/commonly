const express = require('express');
const WebhookDelivery = require('../../models/WebhookDelivery');
const Integration = require('../../models/Integration');
const Pod = require('../../models/Pod');
const Summary = require('../../models/Summary');
const registry = require('../../integrations');
const IntegrationSummaryService = require('../../services/integrationSummaryService');
const AgentEventService = require('../../services/agentEventService');
const telegramService = require('../../services/telegramService');
const { isConnectCodeExpired, registerEnableAttempt } = require('../../services/telegramConnectCode');

const router = express.Router({ mergeParams: true });

const ENABLE_COMMAND = '/commonly-enable';
// Underscore alias: Telegram's registered-command menu forbids hyphens, so
// the menu carries /commonly_enable while typed /commonly-enable keeps working.
const ENABLE_COMMAND_ALIAS = '/commonly_enable';
const SUMMARY_COMMAND = '/summary';
const POD_SUMMARY_COMMAND = '/pod_summary';
const TLDR_COMMAND = '/tldr';
const MODE_COMMAND = '/mode';
const STATUS_COMMAND = '/status';
const MUTE_COMMAND = '/mute';
const UNMUTE_COMMAND = '/unmute';
const HELP_COMMAND = '/help';

const normalizeCommand = (raw = '') => raw.split('@')[0].toLowerCase();

const getMessageFromUpdate = (update: any) => update?.message || update?.channel_post || null;

const getChatTitle = (chat: any) => (
  chat?.title
  || chat?.username
  || [chat?.first_name, chat?.last_name].filter(Boolean).join(' ').trim()
  || 'Telegram chat'
);

// Fail CLOSED (hardening study 2026-08-31, gap 4): with no TELEGRAM_SECRET_TOKEN
// configured this used to accept anything — anyone who found the URL could post
// updates that wake agents and drive /mode //mute. Now a missing secret rejects,
// unless the operator explicitly opts out (TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED=true,
// for local dev only). Deploy note: set TELEGRAM_SECRET_TOKEN and re-register the
// webhook with setWebhook(secret_token=...) BEFORE shipping this to an env with a
// live bridge, or Telegram's deliveries (sent without the header) will 401.
let warnedUnverified = false;
const verifyTelegramHeader = (req: any) => {
  const expectedToken = process.env.TELEGRAM_SECRET_TOKEN;
  if (!expectedToken) {
    if (process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED === 'true') {
      if (!warnedUnverified) {
        warnedUnverified = true;
        console.warn('Telegram webhook: TELEGRAM_SECRET_TOKEN unset and verification explicitly disabled — accepting unverified updates');
      }
      return true;
    }
    if (!warnedUnverified) {
      warnedUnverified = true;
      console.error('Telegram webhook: TELEGRAM_SECRET_TOKEN is not set — rejecting all updates (set the secret and re-register via setWebhook, or set TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED=true for local dev)');
    }
    return false;
  }
  const headerToken = req.headers['x-telegram-bot-api-secret-token'];
  return headerToken && headerToken === expectedToken;
};

const handleEnableCommand = async (chat: any, code: any) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = chat?.id?.toString();
  if (!botToken || !chatId) return;

  if (!code) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      'Usage: /commonly-enable &lt;code&gt; (get the code from Commonly)',
    );
    return;
  }

  // The code is the only proof of ownership this path has (the redeemer is
  // unauthenticated), so guessing is rate-limited per chat and codes expire.
  if (!registerEnableAttempt(chatId)) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      '⚠️ Too many attempts. Wait a few minutes and request a fresh code from Commonly.',
    );
    return;
  }

  const integration = await Integration.findOne({
    type: 'telegram',
    isActive: true,
    'config.connectCode': code,
  });

  if (!integration || isConnectCodeExpired(integration.config)) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      '❌ Invalid or expired code. Please request a fresh code from Commonly.',
    );
    return;
  }

  const existingChatId = integration.config?.chatId;
  if (existingChatId && `${existingChatId}` !== `${chatId}`) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      '⚠️ This code is already linked to another chat. Request a new code.',
    );
    return;
  }

  const chatClaim = await Integration.findOne({
    type: 'telegram',
    isActive: true,
    'config.chatId': chatId,
  });

  if (chatClaim && chatClaim._id.toString() !== integration._id.toString()) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      '⚠️ This chat is already linked to another Commonly pod.',
    );
    return;
  }

  const chatTitle = getChatTitle(chat);
  const chatType = chat?.type || null;

  // Live relay authors inbound as the linked user and streams the pod's
  // escalations outbound; both are only honest in a private 1:1 chat.
  if (integration.config?.liveRelay && chatType !== 'private') {
    await telegramService.sendMessage(
      botToken,
      chatId,
      '⚠️ Live relay only works from a private chat with this bot. Open a direct chat and send the code there.',
    );
    return;
  }

  await Integration.findByIdAndUpdate(integration._id, {
    status: 'connected',
    $set: {
      'config.chatId': chatId,
      'config.chatTitle': chatTitle,
      'config.chatType': chatType,
      'config.webhookListenerEnabled': true,
    },
    $unset: {
      'config.connectCode': '',
      'config.connectCodeExpiresAt': '',
    },
  });

  const pod = await Pod.findById(integration.podId).lean();
  const podName = pod?.name || 'your pod';

  await telegramService.sendMessage(
    botToken,
    chatId,
    `✅ Connected this chat to <b>${podName}</b> in Commonly.\n`
    + 'Agent messages from the pod will appear here. Too chatty? Send '
    + '/mode attention to only get what needs you. /help lists the rest.',
  );
};

const handleSummaryCommand = async (chat: any, integration: any) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chat?.id) return;
  const chatId = chat.id.toString();

  if (!integration) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      'This chat is not linked. Use /commonly-enable &lt;code&gt; first.',
    );
    return;
  }
  if (!integration.podId) {
    await telegramService.sendMessage(botToken, chatId, 'This connector has no active pod. Choose one in Commonly first.');
    return;
  }

  const latest = await Integration.findById(integration._id).lean();
  const buffer = latest?.config?.messageBuffer || [];
  if (!buffer.length) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      'No recent Telegram activity to summarize.',
    );
    return;
  }

  const summary = await IntegrationSummaryService.createSummary(
    latest,
    buffer,
  );

  const { AgentInstallation } = require('../../models/AgentRegistry');
  let installations = [];
  try {
    installations = await AgentInstallation.find({
      agentName: 'commonly-bot',
      podId: latest.podId,
      status: 'active',
    }).lean();
  } catch (err: unknown) {
    console.warn('telegram agent lookup failed', (err as Error).message);
  }

  const targets = installations.length > 0 ? installations : [{ instanceId: 'default' }];

  await Promise.all(
    targets.map((installation: any) => (
      AgentEventService.enqueue({
        agentName: 'commonly-bot',
        instanceId: installation.instanceId || 'default',
        podId: latest.podId,
        type: 'integration.summary',
        payload: {
          summary,
          integrationId: latest._id.toString(),
          source: 'telegram',
        },
      })
    )),
  );

  await Integration.findByIdAndUpdate(integration._id, {
    'config.messageBuffer': [],
    'config.lastSummaryAt': new Date(),
  });
  await telegramService.sendMessage(
    botToken,
    chatId,
    '✅ Queued Telegram summary for Commonly Bot.',
  );
};

const handlePodSummaryCommand = async (chat: any, integration: any) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chat?.id) return;
  const chatId = chat.id.toString();

  if (!integration) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      'This chat is not linked. Use /commonly-enable &lt;code&gt; first.',
    );
    return;
  }
  if (!integration.podId) {
    await telegramService.sendMessage(botToken, chatId, 'This connector has no active pod. Choose one in Commonly first.');
    return;
  }

  const latestSummary = await Summary.findOne({
    type: 'chats',
    podId: integration.podId,
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!latestSummary) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      '📝 No recent pod summaries available yet.',
    );
    return;
  }

  const title = latestSummary.title || 'Pod Summary';
  await telegramService.sendMessage(
    botToken,
    chatId,
    `${title}\n\n${latestSummary.content}`,
  );
};

const sendToChat = async (chatId: string, text: string) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return;
  await telegramService.sendMessage(botToken, chatId, text);
};

const NOT_LINKED = 'This chat is not linked. Use /commonly-enable &lt;code&gt; first.';

const HELP_TEXT = [
  '<b>Commonly bridge commands</b>',
  '/mode — show the relay mode; /mode mirror | attention to switch',
  '  • <b>mirror</b>: every agent message in the pod is copied here',
  '  • <b>attention</b>: only escalations and the lead agent reach you',
  '/status — pod, mode, and mute state for this chat',
  '/mute [minutes] — pause relay to this chat (default 60); /unmute to resume',
  '/tldr — latest pod summary',
  '/summary — summarize recent chat here into the pod',
].join('\n');

// /mode [mirror|attention] — the two relay modes are one stored flag:
// mirror ⇔ config.relayAllAgentMessages. Attention mode leaves the
// escalation gate (markers + lead agent) as the only path to the phone.
const handleModeCommand = async (chat: any, integration: any, arg?: string) => {
  const chatId = chat?.id?.toString();
  if (!integration) return sendToChat(chatId, NOT_LINKED);
  const current = integration.config?.relayAllAgentMessages === true ? 'mirror' : 'attention';
  const wanted = (arg || '').toLowerCase();
  if (!wanted) {
    return sendToChat(chatId, `Relay mode: <b>${current}</b>. Switch with /mode mirror or /mode attention.`);
  }
  if (wanted !== 'mirror' && wanted !== 'attention') {
    return sendToChat(chatId, 'Usage: /mode mirror | attention');
  }
  await Integration.findByIdAndUpdate(integration._id, {
    $set: { 'config.relayAllAgentMessages': wanted === 'mirror' },
  });
  return sendToChat(chatId, wanted === 'mirror'
    ? 'Mode: <b>mirror</b> — every agent message in the pod is copied here.'
    : 'Mode: <b>attention</b> — only escalations and the lead agent reach you.');
};

const handleStatusCommand = async (chat: any, integration: any) => {
  const chatId = chat?.id?.toString();
  if (!integration) return sendToChat(chatId, NOT_LINKED);
  if (!integration.podId) return sendToChat(chatId, 'This connector has no active pod. Choose one in Commonly first.');
  const pod = await Pod.findById(integration.podId).lean();
  const mode = integration.config?.relayAllAgentMessages === true ? 'mirror' : 'attention';
  const mutedUntil = integration.config?.relayMutedUntil;
  const muted = mutedUntil && new Date(mutedUntil) > new Date()
    ? `muted until ${new Date(mutedUntil).toISOString().slice(11, 16)} UTC`
    : 'not muted';
  const lead = integration.config?.leadAgentUsername;
  return sendToChat(chatId, [
    `Pod: <b>${pod?.name || 'unknown'}</b>`,
    `Mode: <b>${mode}</b> · Relay: ${integration.config?.liveRelay ? 'on' : 'off'} · ${muted}`,
    lead ? `Lead agent: ${lead}` : null,
  ].filter(Boolean).join('\n'));
};

const handleMuteCommand = async (chat: any, integration: any, arg?: string) => {
  const chatId = chat?.id?.toString();
  if (!integration) return sendToChat(chatId, NOT_LINKED);
  const minutes = Math.min(Math.max(parseInt(arg || '60', 10) || 60, 1), 24 * 60);
  const until = new Date(Date.now() + minutes * 60_000);
  await Integration.findByIdAndUpdate(integration._id, {
    $set: { 'config.relayMutedUntil': until },
  });
  return sendToChat(chatId, `Muted for ${minutes} min — nothing relays here until then. /unmute to resume.`);
};

const handleUnmuteCommand = async (chat: any, integration: any) => {
  const chatId = chat?.id?.toString();
  if (!integration) return sendToChat(chatId, NOT_LINKED);
  await Integration.findByIdAndUpdate(integration._id, {
    $unset: { 'config.relayMutedUntil': '' },
  });
  return sendToChat(chatId, 'Unmuted — relay resumes.');
};

// Dedup TTL: Telegram redelivers an unacked update for well under this window;
// after it, a reused update_id would be a new update anyway (ids are sequential
// per bot but survive restarts on Telegram's side).
const DEDUP_TTL_MS = 10 * 60_000;

// Atomic claim on this update's delivery id (claim-before-run; see
// models/WebhookDelivery.ts for the contract). Returns 'claimed' | 'duplicate'.
const claimDelivery = async (updateId: any) => {
  try {
    await WebhookDelivery.create({
      provider: 'telegram',
      deliveryId: String(updateId),
      expiresAt: new Date(Date.now() + DEDUP_TTL_MS),
    });
    return 'claimed';
  } catch (err: any) {
    if (err?.code === 11000) return 'duplicate';
    // A dedup-store failure must not take the bridge down: proceed unclaimed
    // (worst case is the pre-existing duplicate behavior, loudly).
    console.error('Telegram webhook: dedup claim failed, processing without a claim', err);
    return 'claimed';
  }
};

const releaseDelivery = async (updateId: any) => {
  try {
    await WebhookDelivery.deleteOne({ provider: 'telegram', deliveryId: String(updateId) });
  } catch (err) {
    console.error('Telegram webhook: failed to release dedup claim', err);
  }
};

// Universal Telegram webhook (single bot, many chats)
router.post('/', async (req: any, res: any) => {
  const updateId = req.body?.update_id;
  try {
    if (!verifyTelegramHeader(req)) {
      return res.status(401).send('invalid secret token');
    }

    // Redelivery of an update we already claimed (processed, or processing on
    // a parallel delivery): ack and stop, or it becomes a duplicate pod
    // message and a duplicate agent wake.
    if (updateId !== undefined && updateId !== null) {
      if ((await claimDelivery(updateId)) === 'duplicate') {
        return res.sendStatus(200);
      }
    }

    const message = getMessageFromUpdate(req.body);
    if (!message) return res.sendStatus(200);
    if (message.via_bot || message.from?.is_bot) return res.sendStatus(200);

    const { chat } = message;
    const chatId = chat?.id?.toString();
    if (!chatId) return res.sendStatus(200);

    const text = (message.text || message.caption || '').replace(/^\uFEFF/, '').trim();
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand?.startsWith('/') ? normalizeCommand(rawCommand) : null;

    if (command === ENABLE_COMMAND || command === ENABLE_COMMAND_ALIAS) {
      await handleEnableCommand(chat, args[0]);
      return res.sendStatus(200);
    }

    const integration = await Integration.findOne({
      type: 'telegram',
      isActive: true,
      'config.chatId': chatId,
      'config.adminPause': { $exists: false },
    });

    if (command === SUMMARY_COMMAND) {
      await handleSummaryCommand(chat, integration);
      return res.sendStatus(200);
    }

    if (command === POD_SUMMARY_COMMAND || command === TLDR_COMMAND) {
      await handlePodSummaryCommand(chat, integration);
      return res.sendStatus(200);
    }

    if (command === MODE_COMMAND) {
      await handleModeCommand(chat, integration, args[0]);
      return res.sendStatus(200);
    }

    if (command === STATUS_COMMAND) {
      await handleStatusCommand(chat, integration);
      return res.sendStatus(200);
    }

    if (command === MUTE_COMMAND) {
      await handleMuteCommand(chat, integration, args[0]);
      return res.sendStatus(200);
    }

    if (command === UNMUTE_COMMAND) {
      await handleUnmuteCommand(chat, integration);
      return res.sendStatus(200);
    }

    if (command === HELP_COMMAND) {
      await sendToChat(chatId, HELP_TEXT);
      return res.sendStatus(200);
    }

    if (!integration) return res.sendStatus(200);

    // Live bridge: linked chats with config.liveRelay relay straight into the
    // pod as real messages (mentions fire, agents wake). Commands above keep
    // their legacy handling; everything else here short-circuits the buffer.
    if (integration.config?.liveRelay) {
      // Deliberately NOT wrapped: a non-2xx makes Telegram redeliver, and
      // whether that retry is a repair or a duplicate depends on which side of
      // the pod write we failed on. relayTelegramMessageToPod swallows its own
      // post-write failures and resolves, so anything that reaches here threw
      // before the message was persisted — nothing exists to duplicate, and the
      // redelivery is the only thing that saves the update. Adding a blanket
      // catch + sendStatus(200) here silently drops those.
      // eslint-disable-next-line global-require
      const bridge = require('../../services/telegramBridgeService');
      await bridge.relayTelegramMessageToPod({
        integration,
        telegramMessage: message,
      });
      return res.sendStatus(200);
    }

    const provider = registry.get('telegram', integration);
    const { events } = provider.getWebhookHandlers();
    // await, not return: a rejected promise returned from inside `try` escapes
    // this catch (express 4 won't catch it either), and the claim above would
    // survive to swallow Telegram's redelivery.
    return await events(req, res);
  } catch (error) {
    console.error('Telegram webhook error', error);
    // Forget-on-error: the 500 makes Telegram redeliver this update_id; the
    // claim must not survive to swallow that retry. (Per the liveRelay comment
    // above, anything that threw did so before the pod write persisted.)
    if (updateId !== undefined && updateId !== null) {
      await releaseDelivery(updateId);
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
// LEGACY: in-platform webhook. External provider service will replace this route.

export {};
