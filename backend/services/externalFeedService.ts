// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const Post = require('../models/Post');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const registry = require('../integrations');
// eslint-disable-next-line global-require
const { normalizeBufferMessage } = require('../integrations/normalizeBufferMessage');
// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');

const FEED_TYPES = ['x', 'instagram'];
const DEFAULT_CATEGORY = 'Social';

interface NormalizedMessage {
  externalId?: string | number;
  content?: string;
  attachments?: Array<string | { url?: string }>;
  timestamp?: string;
  authorName?: string;
  metadata?: {
    url?: string;
    authorUrl?: string;
    username?: string;
  };
}

interface IntegrationDoc {
  _id: unknown;
  podId: unknown;
  type: string;
  isActive: boolean;
  status: string;
  createdBy: unknown;
  config?: {
    category?: string;
    messageBuffer?: Array<{ messageId?: string }>;
    lastExternalId?: string;
    lastExternalTimestamp?: Date;
    maxBufferSize?: number;
    accessToken?: string;
    refreshToken?: string;
  };
}

interface SyncMeta {
  userId?: string;
  username?: string;
  lastExternalIdsByUser?: Record<string, string>;
  watchedUserIds?: string[];
  tokenRefreshed?: boolean;
  refreshedAccessToken?: string;
  refreshedRefreshToken?: string;
  refreshedTokenType?: string;
  refreshedScope?: string;
  refreshedExpiresIn?: number;
  lastExternalIdsByUser?: Record<string, string>;
}

interface SyncResult {
  messages?: NormalizedMessage[];
  content?: string;
  meta?: SyncMeta;
}

interface CuratorDispatch {
  enqueued: number;
  reason?: string;
  targets?: Array<{ agentName: string; instanceId: string }>;
}

interface FeedSyncResult {
  integrationId: unknown;
  success: boolean;
  messageCount: number;
  createdPosts?: number;
  curatorEventsEnqueued?: number;
  curatorTargets?: Array<{ agentName: string; instanceId: string }>;
  content: string;
}

function shouldPersistExternalFeedPosts(): boolean {
  return process.env.EXTERNAL_FEED_PERSIST_POSTS === '1';
}

function getAttachmentUrl(attachments: NormalizedMessage['attachments'] = []): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const first = attachments[0];
  if (!first) return '';
  if (typeof first === 'string') return first;
  return first.url || '';
}

function getNewestTimestamp(messages: NormalizedMessage[] = []): Date | null {
  let newest: Date | null = null;
  messages.forEach((message) => {
    const ts = new Date(message.timestamp as string);
    if (Number.isNaN(ts.valueOf())) return;
    if (!newest || ts > newest) {
      newest = ts;
    }
  });
  return newest;
}

async function persistExternalPosts({
  integration, messages,
}: { integration: IntegrationDoc; messages: NormalizedMessage[] }): Promise<{ created: number }> {
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
    .lean() as Array<{ source?: { externalId?: string } }>;

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
          channel: message.metadata?.username || integration.config?.accessToken || null,
        },
      });
    });

  if (!creations.length) return { created: 0 };
  await Post.insertMany(creations);
  return { created: creations.length };
}

function dedupeBatchByExternalId(messages: NormalizedMessage[] = []): NormalizedMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const externalId = message?.externalId ? String(message.externalId) : '';
    if (!externalId) return false;
    if (seen.has(externalId)) return false;
    seen.add(externalId);
    return true;
  });
}

async function filterAlreadySeenMessages({
  integration, messages,
}: { integration: IntegrationDoc; messages: NormalizedMessage[] }): Promise<NormalizedMessage[]> {
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
    .lean() as Array<{ source?: { externalId?: string } }>;
  const existingPostIds = new Set(
    existingPosts
      .map((post) => String(post?.source?.externalId || '').trim())
      .filter(Boolean),
  );

  return unseenFromBuffer.filter(
    (message) => !existingPostIds.has(String(message.externalId)),
  );
}

async function appendIntegrationBuffer(
  integrationId: unknown,
  messages: NormalizedMessage[],
  maxBufferSize = 1000,
): Promise<void> {
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

function isCuratorInstallation(installation: Record<string, unknown>): boolean {
  const instanceId = String(installation?.instanceId || '').toLowerCase();
  const displayName = String(installation?.displayName || '').toLowerCase();
  const agentName = String(installation?.agentName || '').toLowerCase();
  if (instanceId.includes('curator')) return true;
  if (displayName.includes('curator')) return true;
  return agentName.includes('curator');
}

async function enqueueCuratorEvents({
  integration, messageCount,
}: { integration: IntegrationDoc; messageCount: number }): Promise<CuratorDispatch> {
  if (!integration?.podId) {
    return { enqueued: 0, reason: 'missing_pod' };
  }

  const installations = await AgentInstallation.find({
    podId: integration.podId,
    status: 'active',
  }).select('agentName instanceId displayName config.autonomy').lean() as Array<Record<string, unknown>>;

  const eligibleInstallations = installations
    .filter((installation) => {
      const config = installation?.config as Record<string, unknown> | undefined;
      const autonomy = config?.autonomy as Record<string, unknown> | undefined;
      return autonomy?.enabled !== false;
    })
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
      agentName: installation.agentName as string,
      instanceId: (installation.instanceId as string) || 'default',
    })),
  };
}

async function syncExternalFeeds(): Promise<FeedSyncResult[]> {
  const integrations = await Integration.find({
    type: { $in: FEED_TYPES },
    isActive: true,
    status: 'connected',
  }).lean() as IntegrationDoc[];

  if (!integrations.length) return [];

  const results = await Promise.all(
    integrations.map(async (integration): Promise<FeedSyncResult> => {
      try {
        const provider = registry.get(integration.type, integration);
        const sinceId = integration.config?.lastExternalId;
        const sinceTimestamp = integration.config?.lastExternalTimestamp;
        const syncResult: SyncResult = await provider.syncRecent({ sinceId, sinceTimestamp });

        const updateSet: Record<string, unknown> = {
          lastSync: new Date(),
          status: 'connected',
          errorMessage: null,
          isActive: true,
        };
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
          const pruned = Object.entries(syncResult.meta.lastExternalIdsByUser).reduce<Record<string, string>>((acc, [key, value]) => {
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

        const messages = await filterAlreadySeenMessages({
          integration,
          messages: syncResult.messages || [],
        });
        if (!messages.length) {
          await Integration.findByIdAndUpdate(integration._id, { $set: updateSet });
          return {
            integrationId: integration._id,
            success: true,
            messageCount: 0,
            content: syncResult.content || 'No new posts',
          };
        }

        const newestTimestamp = getNewestTimestamp(messages);
        const newestMessage = messages.reduce<NormalizedMessage | null>((acc, message) => {
          if (!message.timestamp) return acc;
          const ts = new Date(message.timestamp);
          if (Number.isNaN(ts.valueOf())) return acc;
          if (!acc || ts > new Date(acc.timestamp as string)) return message;
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

        if (newestMessage?.externalId) {
          updateSet['config.lastExternalId'] = String(newestMessage.externalId);
        }
        if (newestTimestamp) {
          updateSet['config.lastExternalTimestamp'] = newestTimestamp;
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
      } catch (error) {
        const err = error as {
          response?: { data?: { error_description?: string; error?: string; detail?: string; title?: string } };
          message?: string;
        };
        const detail = err?.response?.data?.error_description
          || err?.response?.data?.error
          || err?.response?.data?.detail
          || err?.response?.data?.title
          || err?.message
          || 'External feed sync failed';
        try {
          await Integration.findByIdAndUpdate(integration._id, {
            $set: {
              status: 'error',
              errorMessage: detail,
              lastSync: new Date(),
            },
          });
        } catch (updateError) {
          console.warn('Failed to persist integration sync error state:', (updateError as Error).message);
        }
        return {
          integrationId: integration._id,
          success: false,
          messageCount: 0,
          content: detail,
        };
      }
    }),
  );

  return results;
}

export { syncExternalFeeds, FEED_TYPES };
