const Integration = require('../models/Integration');
const Post = require('../models/Post');
const { AgentInstallation } = require('../models/AgentRegistry');
const registry = require('../integrations');
const { normalizeBufferMessage } = require('../integrations/normalizeBufferMessage');
const AgentEventService = require('./agentEventService');

const FEED_TYPES = ['x', 'instagram'];
const DEFAULT_CATEGORY = 'Social';

function shouldPersistExternalFeedPosts() {
  return process.env.EXTERNAL_FEED_PERSIST_POSTS === '1';
}

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
  const { createdBy } = integration;

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

function dedupeBatchByExternalId(messages = []) {
  const seen = new Set();
  return messages.filter((message) => {
    const externalId = message?.externalId ? String(message.externalId) : '';
    if (!externalId) return false;
    if (seen.has(externalId)) return false;
    seen.add(externalId);
    return true;
  });
}

async function filterAlreadySeenMessages({ integration, messages }) {
  if (!integration || !messages?.length) return [];

  const candidateMessages = dedupeBatchByExternalId(messages);
  if (!candidateMessages.length) return [];

  const bufferedIds = new Set(
    (integration.config?.messageBuffer || [])
      .map((entry) => String(entry?.messageId || '').trim())
      .filter(Boolean),
  );
  const unseenFromBuffer = candidateMessages.filter(
    (message) => !bufferedIds.has(String(message.externalId)),
  );
  if (!unseenFromBuffer.length) return [];

  const externalIds = unseenFromBuffer.map((message) => String(message.externalId));
  const existingPosts = await Post.find({
    podId: integration.podId,
    'source.provider': integration.type,
    'source.externalId': { $in: externalIds },
  })
    .select('source.externalId')
    .lean();
  const existingPostIds = new Set(
    existingPosts
      .map((post) => String(post?.source?.externalId || '').trim())
      .filter(Boolean),
  );

  return unseenFromBuffer.filter(
    (message) => !existingPostIds.has(String(message.externalId)),
  );
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

function isCuratorInstallation(installation) {
  const instanceId = String(installation?.instanceId || '').toLowerCase();
  const displayName = String(installation?.displayName || '').toLowerCase();
  const agentName = String(installation?.agentName || '').toLowerCase();
  if (instanceId.includes('curator')) return true;
  if (displayName.includes('curator')) return true;
  return agentName.includes('curator');
}

async function enqueueCuratorEvents({ integration, messageCount }) {
  if (!integration?.podId) {
    return { enqueued: 0, reason: 'missing_pod' };
  }

  const installations = await AgentInstallation.find({
    podId: integration.podId,
    status: 'active',
  }).select('agentName instanceId displayName config.autonomy').lean();

  const eligibleInstallations = installations
    .filter((installation) => installation?.config?.autonomy?.enabled !== false)
    .filter((installation) => isCuratorInstallation(installation));

  if (!eligibleInstallations.length) {
    return { enqueued: 0, reason: 'no_curator_installations' };
  }

  const uniqueInstallations = Array.from(
    new Map(
      eligibleInstallations.map((installation) => {
        const key = [
          String(installation.agentName || '').toLowerCase(),
          String(installation.instanceId || 'default'),
        ].join(':');
        return [key, installation];
      }),
    ).values(),
  );

  await Promise.all(
    uniqueInstallations.map((installation) => (
      AgentEventService.enqueue({
        agentName: installation.agentName,
        instanceId: installation.instanceId || 'default',
        podId: integration.podId,
        type: 'curate',
        payload: {
          source: 'external-feed-sync',
          provider: integration.type,
          integrationId: String(integration._id),
          messageCount: Number(messageCount) || 0,
          topN: 3,
          limit: 40,
        },
      })
    )),
  );

  return {
    enqueued: uniqueInstallations.length,
    targets: uniqueInstallations.map((installation) => ({
      agentName: installation.agentName,
      instanceId: installation.instanceId || 'default',
    })),
  };
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

      const messages = await filterAlreadySeenMessages({
        integration,
        messages: syncResult.messages || [],
      });
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

      const created = shouldPersistExternalFeedPosts()
        ? (await persistExternalPosts({ integration, messages })).created
        : 0;
      await appendIntegrationBuffer(
        integration._id,
        messages,
        integration.config?.maxBufferSize || 1000,
      );
      const curatorDispatch = await enqueueCuratorEvents({
        integration,
        messageCount: messages.length,
      });

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
      if (syncResult.meta?.lastExternalIdsByUser && typeof syncResult.meta.lastExternalIdsByUser === 'object') {
        const watchedUserIds = Array.isArray(syncResult.meta?.watchedUserIds)
          ? syncResult.meta.watchedUserIds.map((id) => String(id || '').trim()).filter(Boolean)
          : [];
        const pruned = Object.entries(syncResult.meta.lastExternalIdsByUser).reduce((acc, [key, value]) => {
          const userId = String(key || '').trim();
          const sinceValue = String(value || '').trim();
          if (!userId || !sinceValue) return acc;
          if (watchedUserIds.length && !watchedUserIds.includes(userId)) return acc;
          acc[userId] = sinceValue;
          return acc;
        }, {});
        updateSet['config.lastExternalIdsByUser'] = pruned;
      }
      if (syncResult.meta?.tokenRefreshed && syncResult.meta?.refreshedAccessToken) {
        updateSet['config.accessToken'] = syncResult.meta.refreshedAccessToken;
      }
      if (syncResult.meta?.tokenRefreshed && syncResult.meta?.refreshedRefreshToken) {
        updateSet['config.refreshToken'] = syncResult.meta.refreshedRefreshToken;
      }
      if (syncResult.meta?.tokenRefreshed && syncResult.meta?.refreshedTokenType) {
        updateSet['config.tokenType'] = syncResult.meta.refreshedTokenType;
      }
      if (syncResult.meta?.tokenRefreshed && syncResult.meta?.refreshedScope) {
        updateSet['config.oauthScopes'] = String(syncResult.meta.refreshedScope)
          .split(/\s+/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
      if (syncResult.meta?.tokenRefreshed && syncResult.meta?.refreshedExpiresIn) {
        const seconds = Number(syncResult.meta.refreshedExpiresIn);
        if (Number.isFinite(seconds) && seconds > 0) {
          updateSet['config.tokenExpiresAt'] = new Date(Date.now() + (seconds * 1000));
        }
      }

      await Integration.findByIdAndUpdate(integration._id, { $set: updateSet });

      return {
        integrationId: integration._id,
        success: true,
        messageCount: messages.length,
        createdPosts: created,
        curatorEventsEnqueued: curatorDispatch.enqueued,
        curatorTargets: curatorDispatch.targets || [],
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
