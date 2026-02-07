const axios = require('axios');
const { manifests } = require('../manifests');

let ValidationError;
let validateRequiredConfig;
try {
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ ValidationError } = require('../../../packages/integration-sdk/src/errors'));
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ validateRequiredConfig } = require('../../../packages/integration-sdk/src/manifest'));
} catch (err) {
  ValidationError = class extends Error {};
  validateRequiredConfig = (config, manifest) => {
    const required = manifest?.requiredConfig || [];
    const missing = required.filter((f) => !config?.[f]);
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

async function fetchInstagramMedia({ apiBase, accessToken, igUserId, limit }) {
  const response = await axios.get(`${apiBase}/${igUserId}/media`, {
    params: {
      fields: IG_FIELDS,
      access_token: accessToken,
      limit: limit || 25,
    },
  });
  return response.data?.data || [];
}

function normalizeInstagramMedia(item, config) {
  if (!item) return null;
  const username = item.username || config.username;
  const authorName = username ? `@${username}` : 'Instagram';
  const timestamp = item.timestamp || new Date().toISOString();
  const attachmentUrl = item.media_url || item.thumbnail_url;
  const attachments = attachmentUrl
    ? [{ type: 'image', url: attachmentUrl, title: item.media_type }]
    : [];

  return {
    source: 'instagram',
    externalId: item.id ? String(item.id) : undefined,
    authorId: config.igUserId ? String(config.igUserId) : 'unknown',
    authorName,
    content: item.caption || `${item.media_type || 'Instagram'} post`,
    timestamp,
    attachments,
    metadata: {
      username,
      url: item.permalink,
      mediaType: item.media_type,
    },
    raw: item,
  };
}

function createInstagramProvider(integration) {
  const config = integration?.config || {};
  const apiBase = config.apiBase || process.env.INSTAGRAM_GRAPH_API_BASE || DEFAULT_API_BASE;

  return {
    async validateConfig() {
      try {
        validateRequiredConfig(config, manifests.instagram);
      } catch (err) {
        throw new ValidationError(err.message);
      }
    },

    getWebhookHandlers() {
      return {
        verify: (req, res) => res.sendStatus(200),
        events: (req, res) => res.sendStatus(200),
      };
    },

    async ingestEvent(payload) {
      if (!payload) return [];
      const items = Array.isArray(payload.data) ? payload.data : [payload.media || payload];
      return items.map((item) => normalizeInstagramMedia(item, config)).filter(Boolean);
    },

    async syncRecent({ sinceTimestamp } = {}) {
      const accessToken = config.accessToken;
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
          const ts = new Date(item.timestamp);
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

    async health() {
      const accessToken = config.accessToken;
      if (!accessToken || !config.igUserId) {
        return { ok: false, error: 'Missing Instagram access configuration' };
      }
      return { ok: true };
    },

    async publishPost({ caption, imageUrl, hashtags = [], sourceUrl } = {}) {
      const accessToken = config.accessToken;
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

      const creationId = createRes?.data?.id;
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
        externalId: publishRes?.data?.id || null,
        caption: finalCaption,
      };
    },
  };
}

module.exports = createInstagramProvider;
