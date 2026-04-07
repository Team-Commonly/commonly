// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line global-require
const PodAssetService = require('./podAssetService');
// eslint-disable-next-line global-require
const PodSkillService = require('./podSkillService');

const CHARS_PER_TOKEN = 3; // Conservative estimate for JSON/markdown content

const GENERIC_TAGS = new Set([
  'active', 'activity', 'bot', 'channel', 'chat', 'commonly-bot',
  'commonly-ai-agent', 'discussion', 'during', 'everyone', 'exchanged',
  'general', 'hour', 'integration', 'last', 'member', 'members', 'message',
  'messages', 'moment', 'pod', 'quiet', 'room', 'summary', 'system', 'thread', 'window',
]);

const ASSET_TYPE_WEIGHTS: Record<string, number> = {
  'integration-summary': 1.35,
  summary: 1.2,
  message: 1.0,
  thread: 1.1,
  file: 1.15,
  doc: 1.25,
  link: 1.05,
};

interface CodedError extends Error {
  code: string;
  status: number;
}

interface AssetDoc {
  _id: unknown;
  title?: string;
  type?: string;
  tags?: string[];
  content?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  relevanceScore?: number;
  metadata?: Record<string, unknown>;
  sourceType?: string;
  sourceRef?: unknown;
  score?: number;
}

interface SummaryDoc extends AssetDoc {
  timeRange?: unknown;
}

interface SummaryWithTags extends SummaryDoc {
  tags: string[];
}

interface TagEntry {
  tag: string;
  count: number;
}

interface SkillCandidate {
  id: string;
  name: string;
  tags: string[];
  score: number;
  frequency: number;
  latestAt: unknown;
  assetIds: string[];
  summaryIds: string[];
  preview: Array<{
    id: string;
    title: string;
    type: string;
    createdAt: unknown;
  }>;
}

interface LoadPodOptions {
  podId: string;
  userId: string;
}

interface GetPodContextOptions {
  podId: string;
  userId: string;
  agentContext?: unknown;
  task?: string;
  summaryLimit?: number;
  assetLimit?: number;
  tagLimit?: number;
  skillLimit?: number;
  skillMode?: string;
  skillRefreshHours?: number;
  maxContextTokens?: number;
}

interface PodDescriptor {
  id: string;
  name: string;
  description: string;
  type: string;
}

function buildError(code: string, message: string, status: number): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  error.status = status;
  return error;
}

function toObjectIdString(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof (value as { toString: unknown }).toString === 'function') {
    return (value as { toString: () => string }).toString();
  }
  return String(value);
}

function ensureMembership(pod: { members?: unknown[] }, userId: unknown): boolean {
  const memberIds = (pod.members || []).map((member) => toObjectIdString(member));
  return memberIds.includes(toObjectIdString(userId));
}

function rankByTask<T extends AssetDoc>(
  items: T[],
  taskTokens: Set<string>,
  getTags: (item: T) => string[],
): T[] {
  if (!taskTokens.size) return items;

  const scored = items.map((item) => {
    const tags = (getTags(item) || []).map((tag) => String(tag).toLowerCase());
    const matchCount = tags.reduce(
      (count, tag) => (taskTokens.has(tag) ? count + 1 : count),
      0,
    );
    return {
      ...item,
      relevanceScore: matchCount,
    };
  });

  return scored.sort((a, b) => {
    if ((b.relevanceScore || 0) !== (a.relevanceScore || 0)) {
      return (b.relevanceScore || 0) - (a.relevanceScore || 0);
    }
    return new Date(b.createdAt as string || 0).getTime() - new Date(a.createdAt as string || 0).getTime();
  });
}

function addTagCounts(tagCounts: Map<string, number>, tags: string[]): void {
  (tags || []).forEach((tag) => {
    const normalized = String(tag).trim().toLowerCase();
    if (!normalized) return;
    tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
  });
}

function sortTagCounts(tagCounts: Map<string, number>, limit: number): TagEntry[] {
  return [...tagCounts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isGenericTag(tag: string): boolean {
  return GENERIC_TAGS.has(String(tag).trim().toLowerCase());
}

function daysSince(dateValue: unknown): number {
  const date = new Date(dateValue as string | number);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  const diffMs = Date.now() - date.getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

function hoursSince(dateValue: unknown): number {
  const date = new Date(dateValue as string | number);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  const diffMs = Date.now() - date.getTime();
  return diffMs / (1000 * 60 * 60);
}

function recencyBoost(latestAt: unknown): number {
  const days = daysSince(latestAt);
  if (days <= 1) return 3;
  if (days <= 3) return 2;
  if (days <= 7) return 1.5;
  if (days <= 30) return 1;
  return 0.5;
}

function typeWeightForEntry(entry: AssetDoc & { entryType?: string }): number {
  if (entry.entryType === 'summary') return 1.2;
  return ASSET_TYPE_WEIGHTS[entry.type || ''] || 1.0;
}

function buildSkillCandidates({ assets, summariesWithTags, maxSkills = 6 }: {
  assets: AssetDoc[];
  summariesWithTags: SummaryWithTags[];
  maxSkills?: number;
}): SkillCandidate[] {
  type EntryWithType = AssetDoc & { entryType: string };
  const entries: EntryWithType[] = [
    ...assets.map((asset) => ({ ...asset, entryType: 'asset' as const })),
    ...summariesWithTags.map((summary) => ({ ...summary, entryType: 'summary' as const })),
  ];

  interface TagRecord {
    tag: string;
    count: number;
    latestAt: unknown;
    assetIds: Set<string>;
    summaryIds: Set<string>;
    typeWeights: number[];
    entries: Array<{ id: unknown; title?: string; createdAt?: unknown; entryType: string; type?: string }>;
  }

  const tagMap = new Map<string, TagRecord>();

  entries.forEach((entry) => {
    const tags = (entry.tags || [])
      .map((tag) => String(tag).trim().toLowerCase())
      .filter((tag) => tag.length >= 3 && !isGenericTag(tag));

    const weight = typeWeightForEntry(entry);

    tags.forEach((tag) => {
      if (!tagMap.has(tag)) {
        tagMap.set(tag, {
          tag,
          count: 0,
          latestAt: entry.createdAt || entry.updatedAt || new Date(),
          assetIds: new Set<string>(),
          summaryIds: new Set<string>(),
          typeWeights: [],
          entries: [],
        });
      }

      const record = tagMap.get(tag)!;
      record.count += 1;
      record.latestAt = new Date(record.latestAt as string) > new Date(entry.createdAt as string || 0)
        ? record.latestAt
        : (entry.createdAt || record.latestAt);
      record.typeWeights.push(weight);
      record.entries.push({
        id: entry._id,
        title: entry.title,
        createdAt: entry.createdAt,
        entryType: entry.entryType,
        type: entry.type,
      });

      if (entry.entryType === 'asset') {
        record.assetIds.add(toObjectIdString(entry._id));
      } else {
        record.summaryIds.add(toObjectIdString(entry._id));
      }
    });
  });

  const skills = [...tagMap.values()]
    .map((record): SkillCandidate => {
      const avgTypeWeight = record.typeWeights.length
        ? record.typeWeights.reduce((sum, value) => sum + value, 0) / record.typeWeights.length
        : 1;
      const score = (record.count * 2) + recencyBoost(record.latestAt) + avgTypeWeight;
      const preview = [...record.entries]
        .sort((a, b) => new Date(b.createdAt as string || 0).getTime() - new Date(a.createdAt as string || 0).getTime())
        .slice(0, 3)
        .map((entry) => ({
          id: toObjectIdString(entry.id),
          title: (entry.title as string) || (entry.type as string) || 'Untitled',
          type: entry.entryType === 'summary' ? 'summary' : (entry.type || 'asset'),
          createdAt: entry.createdAt || null,
        }));

      return {
        id: `skill:${record.tag}`,
        name: record.tag,
        tags: [record.tag],
        score: Number(score.toFixed(2)),
        frequency: record.count,
        latestAt: record.latestAt,
        assetIds: [...record.assetIds].slice(0, 8),
        summaryIds: [...record.summaryIds].slice(0, 8),
        preview,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.latestAt as string || 0).getTime() - new Date(a.latestAt as string || 0).getTime();
    })
    .slice(0, maxSkills);

  return skills;
}

class PodContextService {
  static async loadPodForMember({ podId, userId }: LoadPodOptions): Promise<Record<string, unknown>> {
    const pod = await Pod.findById(podId)
      .select('_id name description type members createdAt updatedAt')
      .lean() as Record<string, unknown> | null;

    if (!pod) {
      throw buildError('POD_NOT_FOUND', 'Pod not found', 404);
    }

    if (!ensureMembership(pod as { members?: unknown[] }, userId)) {
      throw buildError('NOT_A_MEMBER', 'Not authorized for this pod', 403);
    }

    return pod;
  }

  static buildTaskTokens(task: string | null): Set<string> {
    if (!task) return new Set();
    const tokens: string[] = PodAssetService.extractKeywords(task, { limit: 12 });
    return new Set(tokens.map((token: string) => token.toLowerCase()));
  }

  static estimateTokens(text: string | null | undefined): number {
    if (!text) return 0;
    return Math.ceil(String(text).length / CHARS_PER_TOKEN);
  }

  static truncateToTokenBudget<T>(
    items: T[],
    budget: number,
    getContent: (item: T) => string,
  ): T[] {
    if (!budget || budget <= 0) return items;
    let used = 0;
    const result: T[] = [];
    for (const item of items) {
      const tokens = PodContextService.estimateTokens(getContent(item));
      if (used + tokens > budget && result.length > 0) break;
      result.push(item);
      used += tokens;
    }
    return result;
  }

  static async getPodContext({
    podId,
    userId,
    agentContext = null,
    task = '',
    summaryLimit = 6,
    assetLimit = 12,
    tagLimit = 16,
    skillLimit = 6,
    skillMode = 'llm',
    skillRefreshHours = 6,
    maxContextTokens = 0,
  }: GetPodContextOptions): Promise<Record<string, unknown>> {
    const pod = await PodContextService.loadPodForMember({ podId, userId });

    const podDescriptor: PodDescriptor = {
      id: toObjectIdString(pod._id),
      name: pod.name as string,
      description: (pod.description as string) || '',
      type: pod.type as string,
    };

    const visibilityFilter = PodAssetService.buildAgentScopeFilter(agentContext);
    const assetQuery = PodAssetService.applyVisibilityFilter(
      { podId, status: 'active', type: { $ne: 'skill' } },
      visibilityFilter,
    );

    const [summaries, assets] = await Promise.all([
      Summary.find({ podId, type: 'chats' })
        .sort({ createdAt: -1 })
        .limit(summaryLimit)
        .lean() as Promise<SummaryDoc[]>,
      PodAsset.find(assetQuery)
        .sort({ createdAt: -1 })
        .limit(assetLimit)
        .lean() as Promise<AssetDoc[]>,
    ]);

    const taskTokens = PodContextService.buildTaskTokens(task);
    const tagCounts = new Map<string, number>();

    const summariesWithTags: SummaryWithTags[] = summaries.map((summary) => {
      const tags: string[] = PodAssetService.buildSummaryTags(summary);
      addTagCounts(tagCounts, tags);
      return {
        ...summary,
        tags,
      };
    });

    assets.forEach((asset) => addTagCounts(tagCounts, asset.tags || []));

    const rankedAssets = rankByTask(assets, taskTokens, (item) => item.tags || []);
    const rankedSummaries = rankByTask(
      summariesWithTags,
      taskTokens,
      (item) => item.tags || [],
    );

    const tags = sortTagCounts(tagCounts, tagLimit);
    const normalizedSkillMode = ['llm', 'heuristic', 'none'].includes(skillMode)
      ? skillMode
      : 'llm';
    let skillModeUsed = normalizedSkillMode;
    const skillWarnings: string[] = [];

    const refreshHours = clamp(Number(skillRefreshHours) || 6, 1, 72);
    const latestSkillQuery = PodAssetService.applyVisibilityFilter(
      { podId, type: 'skill', status: 'active' },
      visibilityFilter,
    );
    const latestSkillAsset = await PodAsset.findOne(latestSkillQuery)
      .sort({ updatedAt: -1 })
      .select('updatedAt')
      .lean() as { updatedAt: unknown } | null;
    const skillAgeHours = latestSkillAsset ? hoursSince(latestSkillAsset.updatedAt) : Number.POSITIVE_INFINITY;

    const shouldRefreshSkills = skillModeUsed === 'llm'
      && PodSkillService.isAvailable()
      && (taskTokens.size > 0 || skillAgeHours > refreshHours);

    if (skillModeUsed === 'llm' && !PodSkillService.isAvailable()) {
      skillWarnings.push('LLM skill synthesis is unavailable (missing GEMINI_API_KEY).');
      skillModeUsed = 'none';
    }

    if (shouldRefreshSkills) {
      const synthesisResult = await PodSkillService.synthesizeSkills({
        pod: podDescriptor,
        task,
        summaries: rankedSummaries,
        assets: rankedAssets,
        skillLimit,
        taskTokens,
      });
      skillWarnings.push(...(synthesisResult.warnings || []));
    }

    const skillAssetsQuery = PodAssetService.applyVisibilityFilter(
      { podId, type: 'skill', status: 'active' },
      visibilityFilter,
    );
    const skillAssets: AssetDoc[] = skillModeUsed === 'none'
      ? []
      : await PodAsset.find(skillAssetsQuery)
        .sort({ 'metadata.score': -1, updatedAt: -1 })
        .limit(skillLimit)
        .lean();

    const importedSkillQuery = PodAssetService.applyVisibilityFilter(
      { podId, type: 'skill', status: 'active', sourceType: 'imported-skill' },
      visibilityFilter,
    );
    const importedSkillAssets: AssetDoc[] = await PodAsset.find(importedSkillQuery)
      .sort({ updatedAt: -1 })
      .limit(40)
      .lean();

    const mergeSkills = (primary: AssetDoc[], secondary: AssetDoc[]): AssetDoc[] => {
      const seen = new Set<string>();
      const merged: AssetDoc[] = [];
      const pushSkill = (skill: AssetDoc | null | undefined) => {
        if (!skill) return;
        const meta = skill.metadata as Record<string, unknown> | undefined;
        const key = (meta?.skillKey as string) || (skill._id as { toString?: () => string })?.toString?.();
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        merged.push(skill);
      };
      primary.forEach(pushSkill);
      secondary.forEach(pushSkill);
      return merged;
    };

    const synthesizedSkills: AssetDoc[] = skillModeUsed === 'heuristic'
      ? buildSkillCandidates({
        assets: rankedAssets,
        summariesWithTags: rankedSummaries,
        maxSkills: skillLimit,
      }).map((skill) => ({
        _id: skill.id,
        title: `Skill: ${skill.name}`,
        content: '',
        tags: skill.tags || [],
        metadata: {
          score: skill.score,
          frequency: skill.frequency,
          heuristic: true,
        },
      }))
      : skillAssets.map((skill) => ({
        ...skill,
        score: (skill.metadata?.score as number) || 0,
        tags: skill.tags || (skill.metadata?.tags as string[]) || [],
      }));

    const skills = mergeSkills(importedSkillAssets, synthesizedSkills);

    const hasActivity = summaries.length > 0 || assets.length > 0;

    let finalSummaries: SummaryWithTags[] = rankedSummaries;
    let finalAssets: AssetDoc[] = rankedAssets;
    let finalSkills: AssetDoc[] = skills;
    let tokenEstimate = 0;

    if (maxContextTokens > 0) {
      const summaryBudget = Math.floor(maxContextTokens * 0.4);
      const assetBudget = Math.floor(maxContextTokens * 0.35);
      const skillBudget = Math.floor(maxContextTokens * 0.25);

      finalSummaries = PodContextService.truncateToTokenBudget(
        rankedSummaries, summaryBudget, (s) => s.content as string || '',
      );
      finalAssets = PodContextService.truncateToTokenBudget(
        rankedAssets, assetBudget, (a) => a.content || a.title || '',
      );
      finalSkills = PodContextService.truncateToTokenBudget(
        skills, skillBudget, (s) => s.content || s.title || '',
      );

      tokenEstimate = [
        ...finalSummaries.map((s) => PodContextService.estimateTokens(s.content as string || '')),
        ...finalAssets.map((a) => PodContextService.estimateTokens(a.content || a.title || '')),
        ...finalSkills.map((s) => PodContextService.estimateTokens(s.content || s.title || '')),
      ].reduce((sum, t) => sum + t, 0);
    }

    return {
      _status: 'success',
      activityAvailable: hasActivity,
      pod: podDescriptor,
      task: task || null,
      stats: {
        summaries: finalSummaries.length,
        assets: finalAssets.length,
        tags: tagCounts.size,
        skills: finalSkills.length,
        ...(maxContextTokens > 0 ? { tokenEstimate, tokenBudget: maxContextTokens } : {}),
      },
      skillModeUsed,
      skillWarnings: skillWarnings.filter((w) => !w.includes('GEMINI_API_KEY')),
      skills: finalSkills,
      tags,
      summaries: finalSummaries,
      assets: finalAssets,
    };
  }
}

export default PodContextService;
