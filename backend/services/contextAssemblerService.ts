/**
 * Context Assembler Service
 *
 * Assembles structured context for agents from pod memory, skills, assets, and summaries.
 * This is the core service that powers the Context API and MCP server.
 */

// eslint-disable-next-line global-require
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const PodAssetService = require('./podAssetService');

// Lazy load vector search (optional dependency)
let vectorSearchService: Record<string, unknown> | null = null;
try {
  // eslint-disable-next-line global-require
  vectorSearchService = require('./vectorSearchService');
} catch {
  console.log('Vector search not available, using keyword fallback');
  vectorSearchService = null;
}
const getVectorSearch = () => vectorSearchService;

// Token estimation (rough approximation)
const CHARS_PER_TOKEN = 4;

interface AssembleContextOptions {
  task?: string | null;
  includeMemory?: boolean;
  includeSkills?: boolean;
  includeSummaries?: boolean;
  maxTokens?: number;
  userId?: unknown;
  agentContext?: unknown;
}

interface WriteMemoryOptions {
  target: string;
  content: string;
  tags?: string[];
  source?: Record<string, unknown>;
  agentContext?: unknown;
  scope?: string;
  metadata?: Record<string, unknown>;
  title?: string;
}

interface GetRelevantSkillsOptions {
  limit?: number;
  maxTokens?: number;
  agentContext?: unknown;
}

interface SearchAssetsOptions {
  limit?: number;
  types?: string[] | null;
  maxTokens?: number;
  agentContext?: unknown;
}

interface GetRecentSummariesOptions {
  hours?: number;
  limit?: number;
  types?: string[] | null;
  maxTokens?: number;
}

interface ReadMemoryFileOptions {
  agentContext?: unknown;
}

interface AssetDoc {
  _id: unknown;
  title?: string;
  content?: string;
  type?: string;
  tags?: string[];
  sourceRef?: unknown;
  relevance?: number;
  matchedChunk?: string;
  updatedAt?: unknown;
}

interface SummaryDoc {
  _id: unknown;
  type?: string;
  content?: string;
  timeRange?: { start?: Date; end?: Date };
  createdAt?: Date;
  metadata?: unknown;
}

interface SkillDoc {
  _id: unknown;
  title?: string;
  content?: string;
  tags?: string[];
  sourceRef?: unknown;
  relevance?: number;
}

interface ContextResult {
  pod: Record<string, unknown> | null;
  memory: string | null;
  skills: unknown[];
  assets: unknown[];
  summaries: unknown[];
  meta: {
    tokenEstimate: number;
    assembledAt: string;
  };
}

class ContextAssemblerService {
  /**
   * Assemble context for a pod
   */
  static async assembleContext(
    podId: unknown,
    options: AssembleContextOptions = {},
  ): Promise<ContextResult> {
    const {
      task = null,
      includeMemory = true,
      includeSkills = true,
      includeSummaries = true,
      maxTokens = 8000,
      userId = null,
      agentContext = null,
    } = options;

    const context: ContextResult = {
      pod: null,
      memory: null,
      skills: [],
      assets: [],
      summaries: [],
      meta: {
        tokenEstimate: 0,
        assembledAt: new Date().toISOString(),
      },
    };

    const pod = await Pod.findById(podId).lean() as Record<string, unknown> | null;
    if (!pod) {
      throw new Error('Pod not found');
    }

    let role = 'viewer';
    if (userId) {
      const members = pod.members as Array<{ userId?: unknown; role?: string }> | undefined;
      const membership = members?.find((m) => m.userId?.toString() === String(userId));
      role = membership?.role || 'viewer';
    }

    context.pod = {
      id: String(pod._id),
      name: pod.name,
      description: pod.description,
      type: pod.type,
      role,
    };

    let remainingTokens = maxTokens;

    if (includeMemory) {
      const normalizedAgent = PodAssetService.normalizeAgentContext(agentContext);
      let memoryAsset: AssetDoc | null = null;
      if (normalizedAgent) {
        memoryAsset = await PodAsset.findOne({
          podId,
          type: 'memory',
          title: 'MEMORY.md',
          'metadata.scope': 'agent',
          'metadata.agentName': normalizedAgent.agentName,
          'metadata.instanceId': normalizedAgent.instanceId,
        }).lean();
      }
      if (!memoryAsset) {
        memoryAsset = await PodAsset.findOne({
          podId,
          type: 'memory',
          title: 'MEMORY.md',
          'metadata.scope': { $ne: 'agent' },
        }).lean();
      }

      if (memoryAsset?.content) {
        const memoryTokens = ContextAssemblerService.estimateTokens(memoryAsset.content);
        if (memoryTokens <= remainingTokens * 0.3) {
          context.memory = memoryAsset.content;
          remainingTokens -= memoryTokens;
          context.meta.tokenEstimate += memoryTokens;
        }
      }
    }

    if (includeSkills) {
      const skills = await ContextAssemblerService.getRelevantSkills(podId, task, {
        limit: 5,
        maxTokens: remainingTokens * 0.2,
        agentContext,
      });

      context.skills = skills.map((s) => ({
        id: String(s._id),
        name: s.title,
        description: s.content?.substring(0, 200),
        instructions: s.content,
        tags: s.tags || [],
        sourceAssetIds: s.sourceRef ? [String(s.sourceRef)] : [],
      }));

      const skillTokens = skills.reduce(
        (sum, s) => sum + ContextAssemblerService.estimateTokens(s.content || ''), 0,
      );
      remainingTokens -= skillTokens;
      context.meta.tokenEstimate += skillTokens;
    }

    if (task) {
      const assets = await ContextAssemblerService.searchAssets(podId, task, {
        limit: 10,
        maxTokens: remainingTokens * 0.3,
        agentContext,
      });

      context.assets = assets.map((a) => ({
        id: String(a._id),
        title: a.title,
        type: a.type,
        snippet: a.content?.substring(0, 300),
        source: {
          type: (a.sourceRef as Record<string, unknown>)?.type || 'unknown',
          ref: (a.sourceRef as Record<string, unknown>)?.id?.toString?.(),
        },
        tags: a.tags || [],
        relevance: a.relevance || 0,
      }));

      const assetTokens = assets.reduce(
        (sum, a) => sum + ContextAssemblerService.estimateTokens(a.content?.substring(0, 300) || ''), 0,
      );
      remainingTokens -= assetTokens;
      context.meta.tokenEstimate += assetTokens;
    }

    if (includeSummaries) {
      const summaries = await ContextAssemblerService.getRecentSummaries(podId, {
        hours: 24,
        limit: 5,
        maxTokens: remainingTokens,
      });

      context.summaries = summaries.map((s) => ({
        id: String(s._id),
        type: s.type,
        content: s.content,
        period: {
          start: s.timeRange?.start?.toISOString() || s.createdAt?.toISOString(),
          end: s.timeRange?.end?.toISOString() || s.createdAt?.toISOString(),
        },
        metadata: s.metadata,
      }));

      const summaryTokens = summaries.reduce(
        (sum, s) => sum + ContextAssemblerService.estimateTokens(s.content || ''), 0,
      );
      context.meta.tokenEstimate += summaryTokens;
    }

    return context;
  }

  /**
   * Get skills relevant to a task using vector search when available
   */
  static async getRelevantSkills(
    podId: unknown,
    task: string | null,
    options: GetRelevantSkillsOptions = {},
  ): Promise<SkillDoc[]> {
    const { limit = 5, agentContext = null } = options;
    const visibilityFilter = PodAssetService.buildAgentScopeFilter(agentContext);

    if (!task) {
      const query = PodAssetService.applyVisibilityFilter(
        { podId, type: 'skill' },
        visibilityFilter,
      );
      return PodAsset.find(query).sort({ updatedAt: -1 }).limit(limit).lean();
    }

    const vs = getVectorSearch();
    if (vs) {
      try {
        const results = await (vs as Record<string, Function>).search(podId, task, {
          limit,
          types: ['skill'],
          hybrid: true,
        }) as Array<{ asset_id: string; combinedScore?: number }>;

        if (results && results.length > 0) {
          const assetIds = results.map((r) => r.asset_id);
          const baseQuery = PodAssetService.applyVisibilityFilter(
            { _id: { $in: assetIds } },
            visibilityFilter,
          );
          const skills: SkillDoc[] = await PodAsset.find(baseQuery).lean();

          return assetIds
            .map((id) => {
              const skill = skills.find((s) => String(s._id) === id);
              const result = results.find((r) => r.asset_id === id);
              return skill ? { ...skill, relevance: result?.combinedScore || 0 } : null;
            })
            .filter((s): s is SkillDoc => s !== null);
        }
      } catch (error) {
        console.error('Skill vector search error:', (error as Error).message);
      }
    }

    const keywords = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const query: Record<string, unknown> = PodAssetService.applyVisibilityFilter(
      { podId, type: 'skill' },
      visibilityFilter,
    );

    if (keywords.length > 0) {
      query.$or = [
        { tags: { $in: keywords } },
        { title: { $regex: keywords.join('|'), $options: 'i' } },
      ];
    }

    return PodAsset.find(query).sort({ updatedAt: -1 }).limit(limit).lean();
  }

  /**
   * Search assets by task/query using hybrid vector + keyword search
   */
  static async searchAssets(
    podId: unknown,
    query: string,
    options: SearchAssetsOptions = {},
  ): Promise<AssetDoc[]> {
    const {
      limit = 10, types = null, maxTokens = 4000, agentContext = null,
    } = options;
    const visibilityFilter = PodAssetService.buildAgentScopeFilter(agentContext);

    const vs = getVectorSearch();
    if (vs) {
      try {
        const searchTypes = types || ['summary', 'integration-summary', 'doc', 'file', 'link', 'thread', 'daily-log'];
        const results = await (vs as Record<string, Function>).search(podId, query, {
          limit: limit * 2,
          types: searchTypes,
          hybrid: true,
        }) as Array<{ asset_id: string; combinedScore?: number; chunk_text?: string }>;

        if (results && results.length > 0) {
          const assetIds = [...new Set(results.map((r) => r.asset_id))];
          const assetsQuery = PodAssetService.applyVisibilityFilter(
            { _id: { $in: assetIds } },
            visibilityFilter,
          );
          const assets: AssetDoc[] = await PodAsset.find(assetsQuery).lean();

          let tokenCount = 0;
          const merged: AssetDoc[] = [];

          for (let i = 0; i < results.length; i += 1) {
            const result = results[i];
            const asset = assets.find((a) => (
              String(a._id) === result.asset_id
              && PodAssetService.isAssetVisible(a, agentContext)
            ));
            if (asset) {
              const assetTokens = ContextAssemblerService.estimateTokens(
                asset.content?.substring(0, 300) || '',
              );
              if (tokenCount + assetTokens > maxTokens && merged.length > 0) break;

              merged.push({
                ...asset,
                relevance: result.combinedScore || 0,
                matchedChunk: result.chunk_text,
              });
              tokenCount += assetTokens;

              if (merged.length >= limit) break;
            }
          }

          return merged;
        }
      } catch (error) {
        console.error('Vector search error, falling back to keyword:', (error as Error).message);
      }
    }

    const searchQuery: Record<string, unknown> = PodAssetService.applyVisibilityFilter(
      {
        podId,
        type: { $nin: ['skill', 'memory'] },
      },
      visibilityFilter,
    );

    if (types) {
      searchQuery.type = { $in: types };
    }

    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (keywords.length > 0) {
      searchQuery.$or = [
        { tags: { $in: keywords } },
        { title: { $regex: keywords.join('|'), $options: 'i' } },
        { content: { $regex: keywords.join('|'), $options: 'i' } },
      ];
    }

    const assets: AssetDoc[] = await PodAsset.find(searchQuery).sort({ updatedAt: -1 }).limit(limit).lean();

    return assets.map((a) => ({
      ...a,
      relevance: ContextAssemblerService.calculateRelevance(a, keywords),
    }));
  }

  /**
   * Get recent summaries for a pod
   */
  static async getRecentSummaries(
    podId: unknown,
    options: GetRecentSummariesOptions = {},
  ): Promise<SummaryDoc[]> {
    const { hours = 24, limit = 5, types = null } = options;

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const query: Record<string, unknown> = {
      podId,
      createdAt: { $gte: since },
      type: { $ne: 'daily-digest' },
    };

    if (types) {
      query.type = { $in: types };
    }

    return Summary.find(query).sort({ createdAt: -1 }).limit(limit).lean();
  }

  /**
   * Read a memory file
   */
  static async readMemoryFile(
    podId: unknown,
    filePath: string,
    options: ReadMemoryFileOptions = {},
  ): Promise<string> {
    const { agentContext = null } = options;
    const normalizedAgent = PodAssetService.normalizeAgentContext(agentContext);

    if (filePath === 'MEMORY.md') {
      let asset: AssetDoc | null = null;
      if (normalizedAgent) {
        asset = await PodAsset.findOne({
          podId,
          type: 'memory',
          title: 'MEMORY.md',
          'metadata.scope': 'agent',
          'metadata.agentName': normalizedAgent.agentName,
          'metadata.instanceId': normalizedAgent.instanceId,
        }).lean();
      }
      if (!asset) {
        asset = await PodAsset.findOne({
          podId,
          type: 'memory',
          title: 'MEMORY.md',
          'metadata.scope': { $ne: 'agent' },
        }).lean();
      }
      return asset?.content || '# Pod Memory\n\nNo curated memory yet.';
    }

    if (filePath === 'SKILLS.md') {
      const skillsQuery = PodAssetService.applyVisibilityFilter(
        { podId, type: 'skill' },
        PodAssetService.buildAgentScopeFilter(agentContext),
      );
      const skills: AssetDoc[] = await PodAsset.find(skillsQuery).sort({ updatedAt: -1 }).lean();
      return ContextAssemblerService.formatSkillsAsMarkdown(skills);
    }

    if (filePath === 'CONTEXT.md') {
      const pod = await Pod.findById(podId).lean() as Record<string, unknown> | null;
      return ContextAssemblerService.formatContextAsMarkdown(pod);
    }

    const dateMatch = filePath.match(/^memory\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (dateMatch) {
      const date = dateMatch[1];
      let asset: AssetDoc | null = null;
      if (normalizedAgent) {
        asset = await PodAsset.findOne({
          podId,
          type: 'daily-log',
          title: `${date}.md`,
          'metadata.scope': 'agent',
          'metadata.agentName': normalizedAgent.agentName,
          'metadata.instanceId': normalizedAgent.instanceId,
        }).lean();
      }
      if (!asset) {
        asset = await PodAsset.findOne({
          podId,
          type: 'daily-log',
          title: `${date}.md`,
          'metadata.scope': { $ne: 'agent' },
        }).lean();
      }
      return asset?.content || `# ${date}\n\nNo activity logged.`;
    }

    const assetQuery = PodAssetService.applyVisibilityFilter(
      { podId, title: filePath },
      PodAssetService.buildAgentScopeFilter(agentContext),
    );
    const asset: AssetDoc | null = await PodAsset.findOne(assetQuery).lean();

    if (!asset) {
      throw new Error(`Memory file not found: ${filePath}`);
    }

    return asset.content || '';
  }

  /**
   * Write to pod memory and index in vector search
   */
  static async writeMemory(podId: unknown, options: WriteMemoryOptions): Promise<{ success: boolean; assetId: string }> {
    const {
      target, content, tags = [], source = {},
    } = options;
    const agentContext = options.agentContext || null;
    const scope = target === 'memory' ? 'pod' : (options.scope || (agentContext ? 'agent' : 'pod'));
    const normalizedAgent = PodAssetService.normalizeAgentContext(agentContext as Record<string, unknown>);
    const metadata = {
      ...(options.metadata || {}),
      scope,
      agentName: normalizedAgent?.agentName,
      instanceId: normalizedAgent?.instanceId,
    };
    const scopeQuery = (() => {
      if (scope === 'agent' && normalizedAgent) {
        return {
          'metadata.scope': 'agent',
          'metadata.agentName': normalizedAgent.agentName,
          'metadata.instanceId': normalizedAgent.instanceId,
        };
      }
      if (scope === 'pod') {
        return {
          $or: [
            { 'metadata.scope': 'pod' },
            { 'metadata.scope': { $exists: false } },
            { 'metadata.scope': null },
          ],
        };
      }
      return { 'metadata.scope': { $ne: 'agent' } };
    })();

    const indexAsset = async (asset: { _id: unknown; [key: string]: unknown }): Promise<void> => {
      const vs = getVectorSearch();
      if (vs) {
        try {
          await (vs as Record<string, Function>).indexAsset(podId, asset);
        } catch (e) {
          console.warn('Failed to index asset in vector search:', (e as Error).message);
        }
      }
    };

    if (target === 'daily') {
      const today = new Date().toISOString().split('T')[0];
      const timestamp = new Date().toISOString().split('T')[1].substring(0, 5);

      const dailyQuery = PodAssetService.applyVisibilityFilter(
        { podId, type: 'daily-log', title: `${today}.md` },
        scopeQuery,
      );
      let asset = await PodAsset.findOne(dailyQuery);

      if (!asset) {
        asset = new PodAsset({
          podId,
          type: 'daily-log',
          title: `${today}.md`,
          content: `# ${today}\n\n`,
          tags: [],
          metadata,
          createdByType: normalizedAgent ? 'agent' : 'user',
        });
      }

      const entry = `**${timestamp}** ${source.agent ? `(${source.agent})` : ''}\n${content}\n\n`;
      asset.content += entry;
      asset.tags = [...new Set([...asset.tags, ...tags])];
      asset.metadata = { ...(asset.metadata || {}), ...metadata };
      await asset.save();
      await indexAsset(asset);

      return { success: true, assetId: String(asset._id) };
    }

    if (target === 'memory') {
      const memoryQuery = PodAssetService.applyVisibilityFilter(
        { podId, type: 'memory', title: 'MEMORY.md' },
        scopeQuery,
      );
      let asset = await PodAsset.findOne(memoryQuery);

      if (!asset) {
        asset = new PodAsset({
          podId,
          type: 'memory',
          title: 'MEMORY.md',
          content: '# Pod Memory\n\n',
          tags: [],
          metadata,
          createdByType: normalizedAgent ? 'agent' : 'user',
        });
      }

      asset.content = content;
      asset.tags = [...new Set([...asset.tags, ...tags])];
      asset.metadata = { ...(asset.metadata || {}), ...metadata };
      await asset.save();
      await indexAsset(asset);

      return { success: true, assetId: String(asset._id) };
    }

    if (target === 'skill') {
      const asset = new PodAsset({
        podId,
        type: 'skill',
        title: options.title || tags[0] || 'Untitled Skill',
        content,
        tags,
        sourceRef: source,
      });
      await asset.save();
      await indexAsset(asset);

      return { success: true, assetId: String(asset._id) };
    }

    throw new Error(`Unknown target: ${target}`);
  }

  /**
   * Estimate token count for text
   */
  static estimateTokens(text: string | null | undefined): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Calculate basic relevance score
   */
  static calculateRelevance(asset: AssetDoc, keywords: string[]): number {
    if (!keywords || keywords.length === 0) return 0.5;

    let score = 0;
    const titleLower = (asset.title || '').toLowerCase();
    const contentLower = (asset.content || '').toLowerCase();
    const tagArr = asset.tags || [];

    keywords.forEach((keyword) => {
      if (titleLower.includes(keyword)) score += 0.3;
      if (contentLower.includes(keyword)) score += 0.2;
      if (tagArr.some((t) => t.toLowerCase().includes(keyword))) score += 0.25;
    });

    return Math.min(score / keywords.length, 1);
  }

  /**
   * Format skills as markdown
   */
  static formatSkillsAsMarkdown(skills: AssetDoc[]): string {
    if (!skills || skills.length === 0) {
      return '# Pod Skills\n\nNo skills have been derived yet.';
    }

    let md = '# Pod Skills\n\n';
    md += `*${skills.length} skills derived from pod activity*\n\n`;

    skills.forEach((skill) => {
      md += `## ${skill.title}\n\n`;
      if ((skill.tags || []).length > 0) {
        md += `**Tags:** ${(skill.tags || []).join(', ')}\n\n`;
      }
      if (skill.content) {
        md += `${skill.content}\n\n`;
      }
      md += '---\n\n';
    });

    return md;
  }

  /**
   * Format context as markdown
   */
  static formatContextAsMarkdown(pod: Record<string, unknown> | null): string {
    if (!pod) {
      return '# Pod Context\n\nPod not found.';
    }

    let md = `# ${pod.name}\n\n`;

    if (pod.description) {
      md += `${pod.description}\n\n`;
    }

    const members = pod.members as unknown[] | undefined;
    md += `**Type:** ${pod.type}\n`;
    md += `**Members:** ${members?.length || 0}\n\n`;

    return md;
  }
}

export default ContextAssemblerService;
