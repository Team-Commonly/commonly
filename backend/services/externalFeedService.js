const Integration = require('../models/Integration');
const Post = require('../models/Post');
const registry = require('../integrations');
const { normalizeBufferMessage } = require('../integrations/normalizeBufferMessage');

const FEED_TYPES = ['x', 'instagram'];
const DEFAULT_CATEGORY = 'Social';

function getAttachmentUrl(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const first = attachments[0];
  if (!first) return '';
  if (typeof first === 'string') return first;
  return first.url || '';
}

function getNewestTimestamp(messages = []) {
  let newest = null;
  messages.forEach((message) => {
    const ts = new Date(message.timestamp);
    if (Number.isNaN(ts.valueOf())) return;
    if (!newest || ts > newest) {
      newest = ts;
    }
  });
  return newest;
}

async function persistExternalPosts({ integration, messages }) {
  if (!integration || !messages?.length) return { created: 0 };

  const externalIds = messages
    .map((message) => message.externalId)
    .filter(Boolean)
    .map(String);

  if (!externalIds.length) return { created: 0 };

  const existingPosts = await Post.find({
    podId: integration.podId,
    'source.provider': integration.type,
    'source.externalId': { $in: externalIds },
  })
    .select('source.externalId')
    .lean();

  const existingIds = new Set(existingPosts.map((post) => post.source?.externalId));
  const category = integration.config?.category || DEFAULT_CATEGORY;
  const createdBy = integration.createdBy;

  const creations = messages
    .filter((message) => message.externalId && !existingIds.has(String(message.externalId)))
    .map((message) => {
      const image = getAttachmentUrl(message.attachments);
      return new Post({
        podId: integration.podId,
        userId: createdBy,
        content: message.content || (image ? 'Shared an attachment' : ''),
        image,
        category,
        source: {
          type: 'external',
          provider: integration.type,
          externalId: String(message.externalId),
          url: message.metadata?.url,
          author: message.authorName,
          authorUrl: message.metadata?.authorUrl,
          channel: message.metadata?.username || integration.config?.username || integration.config?.igUserId || null,
        },
      });
    });

  if (!creations.length) return { created: 0 };
  await Post.insertMany(creations);
  return { created: creations.length };
}

async function appendIntegrationBuffer(integrationId, messages, maxBufferSize = 1000) {
  const bufferMessages = (messages || [])
    .map((message) => normalizeBufferMessage(message))
    .filter(Boolean);

  if (!bufferMessages.length) return;

  await Integration.findByIdAndUpdate(
    integrationId,
    {
      $push: {
        'config.messageBuffer': {
          $each: bufferMessages,
          $slice: -1 * maxBufferSize,
        },
      },
    },
  );
}

async function syncExternalFeeds() {
  const integrations = await Integration.find({
    type: { $in: FEED_TYPES },
    isActive: true,
    status: 'connected',
  }).lean();

  if (!integrations.length) return [];

  const results = await Promise.allSettled(
    integrations.map(async (integration) => {
      const provider = registry.get(integration.type, integration);
      const sinceId = integration.config?.lastExternalId;
      const sinceTimestamp = integration.config?.lastExternalTimestamp;
      const syncResult = await provider.syncRecent({ sinceId, sinceTimestamp });

      const messages = syncResult.messages || [];
      if (!messages.length) {
        return {
          integrationId: integration._id,
          success: true,
          messageCount: 0,
          content: 'No new posts',
        };
      }

      const newestTimestamp = getNewestTimestamp(messages);
      const newestMessage = messages.reduce((acc, message) => {
        if (!message.timestamp) return acc;
        const ts = new Date(message.timestamp);
        if (Number.isNaN(ts.valueOf())) return acc;
        if (!acc || ts > new Date(acc.timestamp)) return message;
        return acc;
      }, null);

      const { created } = await persistExternalPosts({ integration, messages });
      await appendIntegrationBuffer(
        integration._id,
        messages,
        integration.config?.maxBufferSize || 1000,
      );

      const updateSet = {
        lastSync: new Date(),
      };
      if (newestMessage?.externalId) {
        updateSet['config.lastExternalId'] = String(newestMessage.externalId);
      }
      if (newestTimestamp) {
        updateSet['config.lastExternalTimestamp'] = newestTimestamp;
      }
      if (syncResult.meta?.userId) {
        updateSet['config.userId'] = syncResult.meta.userId;
      }
      if (syncResult.meta?.username) {
        updateSet['config.username'] = syncResult.meta.username;
      }

      await Integration.findByIdAndUpdate(integration._id, { $set: updateSet });

      return {
        integrationId: integration._id,
        success: true,
        messageCount: messages.length,
        createdPosts: created,
        content: syncResult.content || 'Synced external feed',
      };
    }),
  ).then((settled) => settled.map((result) => (
    result.status === 'fulfilled' ? result.value : result.reason
  )));

  return results;
}

module.exports = {
  syncExternalFeeds,
  FEED_TYPES,
};
