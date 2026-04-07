// eslint-disable-next-line global-require
const PodAsset = require('../models/PodAsset');

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'almost', 'also', 'among', 'and',
  'because', 'been', 'before', 'being', 'between', 'both', 'came', 'could',
  'each', 'ever', 'from', 'have', 'having', 'into', 'just', 'like', 'made',
  'make', 'many', 'more', 'most', 'much', 'must', 'only', 'other', 'over',
  'same', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'time', 'very', 'want', 'were',
  'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your',
]);

interface AgentContextInput {
  agentName?: string;
  name?: string;
  type?: string;
  instanceId?: string;
}

interface NormalizedAgentContext {
  agentName: string;
  instanceId: string;
}

interface ScopedSkillKeyOptions {
  name: string;
  scope?: string;
  agentName?: string;
  instanceId?: string;
}

interface ChatSummaryInput {
  _id?: unknown;
  title?: string;
  content?: string;
  type?: string;
  timeRange?: unknown;
  metadata?: {
    topTags?: string[];
    topUsers?: string[];
    totalItems?: number;
    podName?: string;
  };
}

interface IntegrationInput {
  _id?: unknown;
  podId?: unknown;
  type?: string;
}

interface IntegrationSummaryInput {
  sourceLabel?: string;
  channelName?: string;
  content?: string;
  channelUrl?: string;
  timeRange?: unknown;
  messageCount?: number;
  summaryType?: string;
  source?: string;
}

interface SkillAssetInput {
  podId: unknown;
  name: string;
  markdown: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface ImportedSkillAssetInput extends SkillAssetInput {
  createdBy?: unknown;
}

interface ExtractKeywordsOptions {
  limit?: number;
}

function truncate(text: string, maxLength = 2000): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function toSkillKey(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.slice(0, 64);
}

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => (
      token
      && token.length >= 4
      && !STOP_WORDS.has(token)
      && !/^\d+$/.test(token)
    ));
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  tokens.forEach((token) => {
    counts.set(token, (counts.get(token) || 0) + 1);
  });
  return counts;
}

function topTokens(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([token]) => token);
}

class PodAssetService {
  static normalizeAgentContext(agentContext: AgentContextInput | null = null): NormalizedAgentContext | null {
    if (!agentContext || typeof agentContext !== 'object') return null;
    const rawName = agentContext.agentName || agentContext.name || agentContext.type;
    if (!rawName) return null;
    return {
      agentName: String(rawName).trim().toLowerCase(),
      instanceId: String(agentContext.instanceId || 'default').trim().toLowerCase(),
    };
  }

  static buildAgentScopeFilter(agentContext: AgentContextInput | null = null): Record<string, unknown> {
    const normalized = PodAssetService.normalizeAgentContext(agentContext);
    if (!normalized) {
      return { 'metadata.scope': { $ne: 'agent' } };
    }

    return {
      $or: [
        { 'metadata.scope': { $ne: 'agent' } },
        {
          'metadata.scope': 'agent',
          'metadata.agentName': normalized.agentName,
          'metadata.instanceId': normalized.instanceId,
        },
      ],
    };
  }

  static applyVisibilityFilter(
    query: Record<string, unknown>,
    visibilityFilter: Record<string, unknown> | null,
  ): Record<string, unknown> {
    if (!visibilityFilter) return query;
    if (!query || typeof query !== 'object') return { $and: [visibilityFilter] };
    if (Array.isArray(query.$and)) {
      return { ...query, $and: [...(query.$and as unknown[]), visibilityFilter] };
    }
    return { ...query, $and: [visibilityFilter] };
  }

  static isAssetVisible(asset: Record<string, unknown> | null, agentContext: AgentContextInput | null = null): boolean {
    if (!asset) return false;
    const metadata = asset?.metadata as Record<string, unknown> | undefined;
    const scope = metadata?.scope;
    if (scope !== 'agent') return true;
    const normalized = PodAssetService.normalizeAgentContext(agentContext);
    if (!normalized) return false;
    return (
      String(metadata?.agentName || '').toLowerCase() === normalized.agentName
      && String(metadata?.instanceId || '').toLowerCase() === normalized.instanceId
    );
  }

  static extractKeywords(text: string, { limit = 8 }: ExtractKeywordsOptions = {}): string[] {
    const tokens = tokenize(text);
    if (!tokens.length) return [];
    const counts = countTokens(tokens);
    return topTokens(counts, limit);
  }

  static normalizeTags(...tagSets: Array<unknown[] | string | undefined | null>): string[] {
    const merged = (tagSets as unknown[])
      .flat()
      .filter(Boolean)
      .map((tag) => String(tag).trim().toLowerCase())
      .filter((tag) => tag.length >= 3);

    return [...new Set(merged)];
  }

  static normalizeSkillKey(name: string): string {
    return toSkillKey(name || 'skill');
  }

  static buildScopedSkillKey({
    name, scope, agentName, instanceId,
  }: ScopedSkillKeyOptions): string {
    const base = PodAssetService.normalizeSkillKey(name);
    if (scope === 'agent' && agentName) {
      const suffix = [agentName, instanceId || 'default']
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
        .join('-');
      return PodAssetService.normalizeSkillKey(`${base}-${suffix}`);
    }
    return base;
  }

  static buildSummaryTags(summary: ChatSummaryInput): string[] {
    const metadataTags = summary?.metadata?.topTags || [];
    const keywordTags = PodAssetService.extractKeywords(
      `${summary?.title || ''} ${summary?.content || ''}`,
    );
    const topUsers = summary?.metadata?.topUsers || [];

    return PodAssetService.normalizeTags(metadataTags, keywordTags, topUsers);
  }

  static async createChatSummaryAsset({ podId, summary }: { podId: unknown; summary: ChatSummaryInput }): Promise<unknown> {
    const tags = PodAssetService.buildSummaryTags(summary);
    const title = summary?.title || 'Chat Summary';

    const asset = await PodAsset.create({
      podId,
      type: 'summary',
      title,
      content: truncate(summary?.content || ''),
      tags,
      sourceType: 'chat-summary',
      sourceRef: {
        summaryId: summary?._id || null,
      },
      metadata: {
        summaryType: summary?.type || 'chats',
        timeRange: summary?.timeRange || null,
        totalItems: summary?.metadata?.totalItems || 0,
        topUsers: summary?.metadata?.topUsers || [],
        podName: summary?.metadata?.podName || null,
      },
      createdByType: 'system',
      status: 'active',
    });

    return asset;
  }

  static async createIntegrationSummaryAsset({
    integration, summary,
  }: { integration: IntegrationInput; summary: IntegrationSummaryInput }): Promise<unknown> {
    const sourceLabel = summary?.sourceLabel || integration?.type || 'External';
    const channelName = summary?.channelName || 'channel';
    const title = `${sourceLabel} Summary · ${channelName}`;

    const tags = PodAssetService.normalizeTags(
      integration?.type,
      sourceLabel,
      channelName,
      PodAssetService.extractKeywords(summary?.content || ''),
    );

    const asset = await PodAsset.create({
      podId: integration?.podId,
      type: 'integration-summary',
      title,
      content: truncate(summary?.content || ''),
      tags,
      sourceType: `${integration?.type || 'external'}-summary`,
      sourceRef: {
        integrationId: integration?._id || null,
      },
      metadata: {
        integrationType: integration?.type || null,
        integrationId: integration?._id || null,
        source: summary?.source || integration?.type || 'external',
        sourceLabel,
        channelName,
        channelUrl: summary?.channelUrl || null,
        timeRange: summary?.timeRange || null,
        messageCount: summary?.messageCount || 0,
        summaryType: summary?.summaryType || null,
      },
      createdByType: 'system',
      status: 'active',
    });

    return asset;
  }

  static async upsertSkillAsset({
    podId, name, markdown, tags = [], metadata = {},
  }: SkillAssetInput): Promise<unknown> {
    const skillKey = PodAssetService.normalizeSkillKey(name);
    const title = `Skill: ${name}`;
    const normalizedTags = PodAssetService.normalizeTags(
      tags,
      (metadata as Record<string, unknown>)?.tags as string[],
      PodAssetService.extractKeywords(name, { limit: 4 }),
    ).slice(0, 16);

    const nextMetadata = {
      ...metadata,
      tags: normalizedTags,
      skillKey,
      skillName: name,
    };

    const asset = await PodAsset.findOneAndUpdate(
      { podId, type: 'skill', 'metadata.skillKey': skillKey },
      {
        $set: {
          podId,
          type: 'skill',
          title,
          content: truncate(markdown || '', 8000),
          tags: normalizedTags,
          sourceType: 'llm-skill',
          metadata: nextMetadata,
          createdByType: 'system',
          status: 'active',
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );

    return asset;
  }

  static async upsertImportedSkillAsset({
    podId, name, markdown, tags = [], metadata = {}, createdBy,
  }: ImportedSkillAssetInput): Promise<unknown> {
    const meta = metadata as Record<string, unknown>;
    const scope = (meta?.scope as string) || 'pod';
    const skillKey = PodAssetService.buildScopedSkillKey({
      name,
      scope,
      agentName: meta?.agentName as string,
      instanceId: meta?.instanceId as string,
    });
    const title = `Skill: ${name}`;
    const normalizedTags = PodAssetService.normalizeTags(
      tags,
      meta?.tags as string[],
      PodAssetService.extractKeywords(name, { limit: 4 }),
    ).slice(0, 16);

    const nextMetadata = {
      ...metadata,
      tags: normalizedTags,
      skillKey,
      skillName: name,
    };

    const asset = await PodAsset.findOneAndUpdate(
      { podId, type: 'skill', 'metadata.skillKey': skillKey },
      {
        $set: {
          podId,
          type: 'skill',
          title,
          content: truncate(markdown || '', 8000),
          tags: normalizedTags,
          sourceType: 'imported-skill',
          metadata: nextMetadata,
          createdBy: createdBy || null,
          createdByType: createdBy ? 'user' : 'system',
          status: 'active',
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );

    return asset;
  }
}

export default PodAssetService;
