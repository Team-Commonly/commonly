const Pod = require('../models/Pod');
const Summary = require('../models/Summary');
const PodAsset = require('../models/PodAsset');
const PodAssetService = require('./podAssetService');
const PodSkillService = require('./podSkillService');

const GENERIC_TAGS = new Set([
  'active',
  'activity',
  'bot',
  'channel',
  'chat',
  'commonly-bot',
  'commonly-ai-agent',
  'discussion',
  'during',
  'everyone',
  'exchanged',
  'general',
  'hour',
  'integration',
  'last',
  'member',
  'members',
  'message',
  'messages',
  'moment',
  'pod',
  'quiet',
  'room',
  'summary',
  'system',
  'thread',
  'window',
]);

const ASSET_TYPE_WEIGHTS = {
  'integration-summary': 1.35,
  summary: 1.2,
  message: 1.0,
  thread: 1.1,
  file: 1.15,
  doc: 1.25,
  link: 1.05,
};

function buildError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function toObjectIdString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
}

function ensureMembership(pod, userId) {
  const memberIds = (pod.members || []).map((member) => toObjectIdString(member));
  return memberIds.includes(toObjectIdString(userId));
}

function rankByTask(items, taskTokens, getTags) {
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
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}

function addTagCounts(tagCounts, tags) {
  (tags || []).forEach((tag) => {
    const normalized = String(tag).trim().toLowerCase();
    if (!normalized) return;
    tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
  });
}

function sortTagCounts(tagCounts, limit) {
  return [...tagCounts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isGenericTag(tag) {
  return GENERIC_TAGS.has(String(tag).trim().toLowerCase());
}

function daysSince(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  const diffMs = Date.now() - date.getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

function hoursSince(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  const diffMs = Date.now() - date.getTime();
  return diffMs / (1000 * 60 * 60);
}

function recencyBoost(latestAt) {
  const days = daysSince(latestAt);
  if (days <= 1) return 3;
  if (days <= 3) return 2;
  if (days <= 7) return 1.5;
  if (days <= 30) return 1;
  return 0.5;
}

function typeWeightForEntry(entry) {
  if (entry.entryType === 'summary') return 1.2;
  return ASSET_TYPE_WEIGHTS[entry.type] || 1.0;
}

function buildSkillCandidates({ assets, summariesWithTags, maxSkills = 6 }) {
  const entries = [
    ...assets.map((asset) => ({ ...asset, entryType: 'asset' })),
    ...summariesWithTags.map((summary) => ({ ...summary, entryType: 'summary' })),
  ];

  const tagMap = new Map();

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
          assetIds: new Set(),
          summaryIds: new Set(),
          typeWeights: [],
          entries: [],
        });
      }

      const record = tagMap.get(tag);
      record.count += 1;
      record.latestAt = new Date(record.latestAt) > new Date(entry.createdAt || 0)
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
    .map((record) => {
      const avgTypeWeight = record.typeWeights.length
        ? record.typeWeights.reduce((sum, value) => sum + value, 0) / record.typeWeights.length
        : 1;
      const score = (record.count * 2) + recencyBoost(record.latestAt) + avgTypeWeight;
      const preview = [...record.entries]
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 3)
        .map((entry) => ({
          id: toObjectIdString(entry.id),
          title: entry.title || entry.type || 'Untitled',
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
      return new Date(b.latestAt || 0) - new Date(a.latestAt || 0);
    })
    .slice(0, maxSkills);

  return skills;
}

class PodContextService {
  static async loadPodForMember({ podId, userId }) {
    const pod = await Pod.findById(podId)
      .select('_id name description type members createdAt updatedAt')
      .lean();

    if (!pod) {
      throw buildError('POD_NOT_FOUND', 'Pod not found', 404);
    }

    if (!ensureMembership(pod, userId)) {
      throw buildError('NOT_A_MEMBER', 'Not authorized for this pod', 403);
    }

    return pod;
  }

  static buildTaskTokens(task) {
    if (!task) return new Set();
    const tokens = PodAssetService.extractKeywords(task, { limit: 12 });
    return new Set(tokens.map((token) => token.toLowerCase()));
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
  }) {
    const pod = await PodContextService.loadPodForMember({ podId, userId });

    const podDescriptor = {
      id: toObjectIdString(pod._id),
      name: pod.name,
      description: pod.description || '',
      type: pod.type,
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
        .lean(),
      PodAsset.find(assetQuery)
        .sort({ createdAt: -1 })
        .limit(assetLimit)
        .lean(),
    ]);

    const taskTokens = PodContextService.buildTaskTokens(task);
    const tagCounts = new Map();

    const summariesWithTags = summaries.map((summary) => {
      const tags = PodAssetService.buildSummaryTags(summary);
      addTagCounts(tagCounts, tags);
      return {
        ...summary,
        tags,
      };
    });

    assets.forEach((asset) => addTagCounts(tagCounts, asset.tags));

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
    const skillWarnings = [];

    const refreshHours = clamp(Number(skillRefreshHours) || 6, 1, 72);
    const latestSkillQuery = PodAssetService.applyVisibilityFilter(
      { podId, type: 'skill', status: 'active' },
      visibilityFilter,
    );
    const latestSkillAsset = await PodAsset.findOne(latestSkillQuery)
      .sort({ updatedAt: -1 })
      .select('updatedAt')
      .lean();
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
    const skillAssets = skillModeUsed === 'none'
      ? []
      : await PodAsset.find(skillAssetsQuery)
        .sort({ 'metadata.score': -1, updatedAt: -1 })
        .limit(skillLimit)
        .lean();

    const importedSkillQuery = PodAssetService.applyVisibilityFilter(
      { podId, type: 'skill', status: 'active', sourceType: 'imported-skill' },
      visibilityFilter,
    );
    const importedSkillAssets = await PodAsset.find(importedSkillQuery)
      .sort({ updatedAt: -1 })
      .limit(40)
      .lean();

    const mergeSkills = (primary, secondary) => {
      const seen = new Set();
      const merged = [];
      const pushSkill = (skill) => {
        if (!skill) return;
        const key = skill?.metadata?.skillKey || skill?._id?.toString?.();
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        merged.push(skill);
      };
      primary.forEach(pushSkill);
      secondary.forEach(pushSkill);
      return merged;
    };

    const synthesizedSkills = skillModeUsed === 'heuristic'
      ? buildSkillCandidates({
        assets: rankedAssets,
        summariesWithTags: rankedSummaries,
        maxSkills: skillLimit,
      }).map((skill) => ({
        id: skill.id,
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
        score: skill.metadata?.score || 0,
        tags: skill.tags || skill.metadata?.tags || [],
      }));

    const skills = mergeSkills(importedSkillAssets, synthesizedSkills);

    return {
      pod: podDescriptor,
      task: task || null,
      stats: {
        summaries: summaries.length,
        assets: assets.length,
        tags: tagCounts.size,
        skills: skills.length,
      },
      skillModeUsed,
      skillWarnings,
      skills,
      tags,
      summaries: rankedSummaries,
      assets: rankedAssets,
    };
  }
}

module.exports = PodContextService;
