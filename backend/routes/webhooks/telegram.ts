// @ts-nocheck
const express = require('express');
const Integration = require('../../models/Integration');
const Pod = require('../../models/Pod');
const Summary = require('../../models/Summary');
const registry = require('../../integrations');
const IntegrationSummaryService = require('../../services/integrationSummaryService');
const AgentEventService = require('../../services/agentEventService');
const telegramService = require('../../services/telegramService');

const router = express.Router({ mergeParams: true });

const ENABLE_COMMAND = '/commonly-enable';
const SUMMARY_COMMAND = '/summary';
const POD_SUMMARY_COMMAND = '/pod_summary';

const normalizeCommand = (raw = '') => raw.split('@')[0].toLowerCase();

const getMessageFromUpdate = (update) => update?.message || update?.channel_post || null;

const getChatTitle = (chat) => (
  chat?.title
  || chat?.username
  || [chat?.first_name, chat?.last_name].filter(Boolean).join(' ').trim()
  || 'Telegram chat'
);

const verifyTelegramHeader = (req) => {
  const expectedToken = process.env.TELEGRAM_SECRET_TOKEN;
  if (!expectedToken) return true;
  const headerToken = req.headers['x-telegram-bot-api-secret-token'];
  return headerToken && headerToken === expectedToken;
};

const handleEnableCommand = async (chat, code) => {
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

  const integration = await Integration.findOne({
    type: 'telegram',
    isActive: true,
    'config.connectCode': code,
  });

  if (!integration) {
    await telegramService.sendMessage(
      botToken,
      chatId,
      '❌ Invalid code. Please request a fresh code from Commonly.',
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
    },
  });

  const pod = await Pod.findById(integration.podId).lean();
  const podName = pod?.name || 'your pod';

  await telegramService.sendMessage(
    botToken,
    chatId,
    `✅ Connected this chat to <b>${podName}</b> in Commonly.`,
  );
};

const handleSummaryCommand = async (chat, integration) => {
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
  } catch (err) {
    console.warn('telegram agent lookup failed', err.message);
  }

  const targets = installations.length > 0 ? installations : [{ instanceId: 'default' }];

  await Promise.all(
    targets.map((installation) => (
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

const handlePodSummaryCommand = async (chat, integration) => {
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

// Universal Telegram webhook (single bot, many chats)
router.post('/', async (req, res) => {
  try {
    if (!verifyTelegramHeader(req)) {
      return res.status(401).send('invalid secret token');
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

    if (command === ENABLE_COMMAND) {
      await handleEnableCommand(chat, args[0]);
      return res.sendStatus(200);
    }

    const integration = await Integration.findOne({
      type: 'telegram',
      isActive: true,
      'config.chatId': chatId,
    });

    if (command === SUMMARY_COMMAND) {
      await handleSummaryCommand(chat, integration);
      return res.sendStatus(200);
    }

    if (command === POD_SUMMARY_COMMAND) {
      await handlePodSummaryCommand(chat, integration);
      return res.sendStatus(200);
    }

    if (!integration) return res.sendStatus(200);

    const provider = registry.get('telegram', integration);
    const { events } = provider.getWebhookHandlers();
    return events(req, res);
  } catch (error) {
    console.error('Telegram webhook error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
// LEGACY: in-platform webhook. External provider service will replace this route.
