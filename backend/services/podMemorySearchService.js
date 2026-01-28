const PodAsset = require('../models/PodAsset');
const PodAssetService = require('./podAssetService');
const PodContextService = require('./podContextService');

const MAX_LIMIT = 40;
const DEFAULT_LIMIT = 8;
const MAX_EXCERPT_LINES = 100;
const DEFAULT_EXCERPT_LINES = 12;
const MAX_SNIPPET_CHARS = 320;
const MAX_EXCERPT_CHARS = 2000;

function buildError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildSnippet({ content, query, maxChars = MAX_SNIPPET_CHARS }) {
  const normalized = normalizeText(content);
  if (!normalized) return '';
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return normalized.slice(0, maxChars);
  const haystack = normalized.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index === -1) {
    return normalized.slice(0, maxChars);
  }
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(normalized.length, start + maxChars);
  let snippet = normalized.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < normalized.length) snippet = `${snippet}…`;
  return snippet;
}

function buildExcerpt(content, from, lines) {
  const text = String(content || '');
  if (!text) {
    return {
      text: '',
      startLine: 0,
      endLine: 0,
      totalLines: 0,
    };
  }
  const rows = text.split(/\r?\n/);
  const totalLines = rows.length;
  const safeFrom = clamp(from, 1, totalLines);
  const safeLines = clamp(lines, 1, MAX_EXCERPT_LINES);
  const startIndex = safeFrom - 1;
  const endIndex = Math.min(totalLines, startIndex + safeLines);
  let excerpt = rows.slice(startIndex, endIndex).join('\n');
  if (excerpt.length > MAX_EXCERPT_CHARS) {
    excerpt = `${excerpt.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
  }
  return {
    text: excerpt,
    startLine: safeFrom,
    endLine: endIndex,
    totalLines,
  };
}

function computeFallbackScore(asset, tokens) {
  if (!tokens.length) return 0;
  const title = String(asset.title || '').toLowerCase();
  const content = String(asset.content || '').toLowerCase();
  const tags = (asset.tags || []).map((tag) => String(tag).toLowerCase());
  let score = 0;
  tokens.forEach((token) => {
    if (tags.includes(token)) score += 4;
    if (title.includes(token)) score += 3;
    if (content.includes(token)) score += 1;
  });
  return score;
}

class PodMemorySearchService {
  static async searchPodMemory({
    podId,
    userId,
    query,
    limit = DEFAULT_LIMIT,
    includeSkills = false,
    types = [],
  }) {
    await PodContextService.loadPodForMember({ podId, userId });

    const cleanedQuery = String(query || '').trim();
    if (!cleanedQuery) {
      throw buildError('QUERY_REQUIRED', 'Query is required', 400);
    }

    const safeLimit = clamp(Number(limit) || DEFAULT_LIMIT, 1, MAX_LIMIT);
    const filter = {
      podId,
      status: 'active',
    };

    if (Array.isArray(types) && types.length) {
      filter.type = { $in: types };
    } else if (!includeSkills) {
      filter.type = { $ne: 'skill' };
    }

    let assets = [];
    let usedTextSearch = true;

    try {
      assets = await PodAsset.find(
        { ...filter, $text: { $search: cleanedQuery } },
        { score: { $meta: 'textScore' } },
      )
        .sort({ score: { $meta: 'textScore' }, updatedAt: -1 })
        .limit(safeLimit)
        .lean();
    } catch (error) {
      usedTextSearch = false;
    }

    if (!usedTextSearch) {
      const tokens = PodAssetService.extractKeywords(cleanedQuery, { limit: 8 });
      const pattern = tokens.length
        ? tokens.map(escapeRegex).join('|')
        : escapeRegex(cleanedQuery);
      const regex = new RegExp(pattern, 'i');
      assets = await PodAsset.find({
        ...filter,
        $or: [
          { title: regex },
          { content: regex },
          { tags: regex },
        ],
      })
        .sort({ updatedAt: -1 })
        .limit(safeLimit)
        .lean();
      assets = assets.map((asset) => ({
        ...asset,
        score: computeFallbackScore(asset, tokens),
      }))
        .sort((a, b) => {
          if ((b.score || 0) !== (a.score || 0)) {
            return (b.score || 0) - (a.score || 0);
          }
          return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
        })
        .slice(0, safeLimit);
    }

    const results = assets.map((asset) => ({
      assetId: asset._id?.toString?.() || String(asset._id),
      title: asset.title,
      type: asset.type,
      tags: asset.tags || [],
      score: Number(asset.score || 0),
      snippet: buildSnippet({ content: asset.content || asset.title, query: cleanedQuery }),
      sourceType: asset.sourceType || null,
      sourceRef: asset.sourceRef || {},
      createdAt: asset.createdAt || null,
      updatedAt: asset.updatedAt || null,
    }));

    return {
      query: cleanedQuery,
      usedTextSearch,
      results,
    };
  }

  static async getAssetExcerpt({
    podId,
    userId,
    assetId,
    from = 1,
    lines = DEFAULT_EXCERPT_LINES,
  }) {
    await PodContextService.loadPodForMember({ podId, userId });

    const asset = await PodAsset.findOne({
      _id: assetId,
      podId,
      status: 'active',
    }).lean();

    if (!asset) {
      throw buildError('ASSET_NOT_FOUND', 'Asset not found', 404);
    }

    const excerpt = buildExcerpt(asset.content || '', Number(from) || 1, Number(lines) || DEFAULT_EXCERPT_LINES);

    return {
      assetId: asset._id?.toString?.() || String(asset._id),
      title: asset.title,
      type: asset.type,
      tags: asset.tags || [],
      sourceType: asset.sourceType || null,
      sourceRef: asset.sourceRef || {},
      createdAt: asset.createdAt || null,
      updatedAt: asset.updatedAt || null,
      ...excerpt,
    };
  }
}

module.exports = PodMemorySearchService;
