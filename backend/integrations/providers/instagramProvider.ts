// eslint-disable-next-line global-require
const axios = require('axios');
// eslint-disable-next-line global-require
const { manifests } = require('../manifests');

interface InstagramConfig {
  accessToken?: string;
  igUserId?: string;
  username?: string;
  apiBase?: string;
  maxResults?: number;
  [key: string]: unknown;
}

interface InstagramMediaItem {
  id?: string | number;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  username?: string;
}

interface NormalizedInstagramPost {
  source: 'instagram';
  externalId: string | undefined;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  attachments: Array<{ type: string; url: string; title: string | undefined }>;
  metadata: { username: string | undefined; url: string | undefined; mediaType: string | undefined };
  raw: unknown;
}

interface SyncRecentOpts {
  sinceTimestamp?: string;
}

interface PublishPostOpts {
  caption?: string;
  imageUrl?: string;
  hashtags?: unknown[];
  sourceUrl?: string;
}

interface InstagramProvider {
  validateConfig(): Promise<void>;
  getWebhookHandlers(): Record<string, (req: unknown, res: unknown) => unknown>;
  ingestEvent(payload: unknown): Promise<NormalizedInstagramPost[]>;
  syncRecent(opts?: SyncRecentOpts): Promise<unknown>;
  health(): Promise<{ ok: boolean; error?: string }>;
  publishPost(opts?: PublishPostOpts): Promise<{ success: boolean; provider: string; externalId: string | null; caption: string }>;
}

let ValidationError: new (msg: string) => Error;
let validateRequiredConfig: (config: unknown, manifest: unknown) => void;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  ({ ValidationError } = require('../../../packages/integration-sdk/src/errors'));
  // eslint-disable-next-line global-require, import/no-unresolved
  ({ validateRequiredConfig } = require('../../../packages/integration-sdk/src/manifest'));
} catch {
  ValidationError = class extends Error {};
  validateRequiredConfig = (config: unknown, manifest: unknown) => {
    const required = (manifest as { requiredConfig?: string[] })?.requiredConfig || [];
    const missing = required.filter((f) => !(config as Record<string, unknown>)?.[f]);
    if (missing.length) throw new ValidationError(`Missing fields: ${missing.join(', ')}`);
  };
}

const DEFAULT_API_BASE = 'https://graph.facebook.com/v19.0';
const IG_FIELDS = [
  'id',
  'caption',
  'media_type',
  'media_url',
  'thumbnail_url',
  'permalink',
  'timestamp',
  'username',
].join(',');

async function fetchInstagramMedia({ apiBase, accessToken, igUserId, limit }: { apiBase: string; accessToken: string; igUserId: string; limit?: number }): Promise<InstagramMediaItem[]> {
  const response = await axios.get(`${apiBase}/${igUserId}/media`, {
    params: {
      fields: IG_FIELDS,
      access_token: accessToken,
      limit: limit || 25,
    },
  });
  return (response.data?.data || []) as InstagramMediaItem[];
}

function normalizeInstagramMedia(item: unknown, config: InstagramConfig): NormalizedInstagramPost | null {
  if (!item) return null;
  const media = item as InstagramMediaItem;
  const username = media.username || config.username;
  const authorName = username ? `@${username}` : 'Instagram';
  const timestamp = media.timestamp || new Date().toISOString();
  const attachmentUrl = media.media_url || media.thumbnail_url;
  const attachments = attachmentUrl
    ? [{ type: 'image', url: attachmentUrl, title: media.media_type }]
    : [];

  return {
    source: 'instagram',
    externalId: media.id ? String(media.id) : undefined,
    authorId: config.igUserId ? String(config.igUserId) : 'unknown',
    authorName,
    content: media.caption || `${media.media_type || 'Instagram'} post`,
    timestamp,
    attachments,
    metadata: {
      username,
      url: media.permalink,
      mediaType: media.media_type,
    },
    raw: item,
  };
}

function createInstagramProvider(integration: { _id: unknown; config?: InstagramConfig; [key: string]: unknown }): InstagramProvider {
  const config = (integration?.config || {}) as InstagramConfig;
  const apiBase = config.apiBase || process.env.INSTAGRAM_GRAPH_API_BASE || DEFAULT_API_BASE;

  return {
    async validateConfig() {
      try {
        validateRequiredConfig(config, manifests.instagram);
      } catch (err) {
        const e = err as { message?: string };
        throw new ValidationError(e.message || 'Validation failed');
      }
    },

    getWebhookHandlers() {
      return {
        verify: (_req: unknown, res: { sendStatus: (n: number) => unknown }) => res.sendStatus(200),
        events: (_req: unknown, res: { sendStatus: (n: number) => unknown }) => res.sendStatus(200),
      };
    },

    async ingestEvent(payload: unknown): Promise<NormalizedInstagramPost[]> {
      if (!payload) return [];
      const p = payload as { data?: unknown[]; media?: unknown };
      const items = Array.isArray(p.data) ? p.data : [p.media || payload];
      return items.map((item) => normalizeInstagramMedia(item, config)).filter((x): x is NormalizedInstagramPost => x !== null);
    },

    async syncRecent({ sinceTimestamp } = {}): Promise<unknown> {
      const { accessToken } = config;
      if (!accessToken) {
        throw new Error('Missing Instagram access token');
      }
      if (!config.igUserId) {
        throw new Error('Missing Instagram IG user id');
      }

      const media = await fetchInstagramMedia({
        apiBase,
        accessToken,
        igUserId: config.igUserId,
        limit: config.maxResults || 25,
      });

      const sinceDate = sinceTimestamp ? new Date(sinceTimestamp) : null;
      const filtered = sinceDate
        ? media.filter((item) => {
          const ts = new Date(item.timestamp || '');
          return Number.isNaN(ts.valueOf()) ? true : ts > sinceDate;
        })
        : media;

      const messages = filtered
        .map((item) => normalizeInstagramMedia(item, config))
        .filter(Boolean);

      return {
        success: true,
        messageCount: messages.length,
        messages,
        content: messages.length ? `Fetched ${messages.length} post(s) from Instagram` : 'No new posts',
        meta: {
          username: config.username,
        },
      };
    },

    async health(): Promise<{ ok: boolean; error?: string }> {
      const { accessToken } = config;
      if (!accessToken || !config.igUserId) {
        return { ok: false, error: 'Missing Instagram access configuration' };
      }
      return { ok: true };
    },

    async publishPost({ caption, imageUrl, hashtags = [], sourceUrl } = {}): Promise<{ success: boolean; provider: string; externalId: string | null; caption: string }> {
      const { accessToken } = config;
      if (!accessToken || !config.igUserId) {
        throw new Error('Missing Instagram access configuration');
      }
      if (!imageUrl) {
        throw new Error('imageUrl is required for Instagram publishing');
      }

      const normalizedTags = Array.isArray(hashtags)
        ? hashtags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 8)
        : [];
      const baseCaption = String(caption || '').trim();
      const sourceLine = sourceUrl ? `\n\nSource: ${String(sourceUrl).trim()}` : '';
      const tagsLine = normalizedTags.length ? `\n\n${normalizedTags.join(' ')}` : '';
      let finalCaption = `${baseCaption}${tagsLine}${sourceLine}`.trim();
      if (finalCaption.length > 2200) {
        finalCaption = `${finalCaption.slice(0, 2197)}...`;
      }

      const createRes = await axios.post(
        `${apiBase}/${config.igUserId}/media`,
        null,
        {
          params: {
            image_url: String(imageUrl).trim(),
            caption: finalCaption,
            access_token: accessToken,
          },
        },
      );

      const creationId = createRes?.data?.id as string | undefined;
      if (!creationId) {
        throw new Error('Failed to create Instagram media container');
      }

      const publishRes = await axios.post(
        `${apiBase}/${config.igUserId}/media_publish`,
        null,
        {
          params: {
            creation_id: creationId,
            access_token: accessToken,
          },
        },
      );

      return {
        success: true,
        provider: 'instagram',
        externalId: (publishRes?.data?.id as string) || null,
        caption: finalCaption,
      };
    },
  };
}

module.exports = createInstagramProvider;

export {};
