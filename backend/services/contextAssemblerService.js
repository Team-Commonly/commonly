/**
 * Context Assembler Service
 *
 * Assembles structured context for agents from pod memory, skills, assets, and summaries.
 * This is the core service that powers the Context API and MCP server.
 *
 * Features:
 * - Hybrid search (vector + keyword) when available
 * - Token-budgeted context assembly
 * - Memory file abstraction (MEMORY.md, SKILLS.md, daily logs)
 * - Skill relevance ranking
 */

const PodAsset = require('../models/PodAsset');
const Summary = require('../models/Summary');
const Pod = require('../models/Pod');
const PodAssetService = require('./podAssetService');

// Lazy load vector search (optional dependency)
let vectorSearchService = null;
try {
  // eslint-disable-next-line global-require
  vectorSearchService = require('./vectorSearchService');
} catch (e) {
  console.log('Vector search not available, using keyword fallback');
  vectorSearchService = null;
}
const getVectorSearch = () => vectorSearchService;

// Token estimation (rough approximation)
const CHARS_PER_TOKEN = 4;

class ContextAssemblerService {
  /**
   * Assemble context for a pod
   */
  static async assembleContext(podId, options = {}) {
    const {
      task = null,
      includeMemory = true,
      includeSkills = true,
      includeSummaries = true,
      maxTokens = 8000,
      userId = null,
      agentContext = null,
    } = options;

    const context = {
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

    // 1. Get pod metadata
    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      throw new Error('Pod not found');
    }

    // Determine user's role
    let role = 'viewer';
    if (userId) {
      const membership = pod.members?.find((m) => m.userId?.toString() === userId.toString());
      role = membership?.role || 'viewer';
    }

    context.pod = {
      id: pod._id.toString(),
      name: pod.name,
      description: pod.description,
      type: pod.type,
      role,
    };

    let remainingTokens = maxTokens;

    // 2. Load pod memory (MEMORY.md equivalent)
    if (includeMemory) {
      const normalizedAgent = PodAssetService.normalizeAgentContext(agentContext);
      let memoryAsset = null;
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
        const memoryTokens = this.estimateTokens(memoryAsset.content);
        if (memoryTokens <= remainingTokens * 0.3) {
          // Cap memory at 30% of budget
          context.memory = memoryAsset.content;
          remainingTokens -= memoryTokens;
          context.meta.tokenEstimate += memoryTokens;
        }
      }
    }

    // 3. Get relevant skills
    if (includeSkills) {
      const skills = await this.getRelevantSkills(podId, task, {
        limit: 5,
        maxTokens: remainingTokens * 0.2, // 20% for skills
        agentContext,
      });

      context.skills = skills.map((s) => ({
        id: s._id.toString(),
        name: s.title,
        description: s.content?.substring(0, 200),
        instructions: s.content,
        tags: s.tags || [],
        sourceAssetIds: s.sourceRef ? [s.sourceRef.toString()] : [],
      }));

      const skillTokens = skills.reduce((sum, s) => sum + this.estimateTokens(s.content || ''), 0);
      remainingTokens -= skillTokens;
      context.meta.tokenEstimate += skillTokens;
    }

    // 4. Search relevant assets
    if (task) {
      const assets = await this.searchAssets(podId, task, {
        limit: 10,
        maxTokens: remainingTokens * 0.3,
        agentContext,
      });

      context.assets = assets.map((a) => ({
        id: a._id.toString(),
        title: a.title,
        type: a.type,
        snippet: a.content?.substring(0, 300),
        source: {
          type: a.sourceRef?.type || 'unknown',
          ref: a.sourceRef?.id?.toString(),
        },
        tags: a.tags || [],
        relevance: a.relevance || 0,
      }));

      const assetTokens = assets.reduce((sum, a) => sum + this.estimateTokens(a.content?.substring(0, 300) || ''), 0);
      remainingTokens -= assetTokens;
      context.meta.tokenEstimate += assetTokens;
    }

    // 5. Get recent summaries
    if (includeSummaries) {
      const summaries = await this.getRecentSummaries(podId, {
        hours: 24,
        limit: 5,
        maxTokens: remainingTokens,
      });

      context.summaries = summaries.map((s) => ({
        id: s._id.toString(),
        type: s.type,
        content: s.content,
        period: {
          start: s.timeRange?.start?.toISOString() || s.createdAt?.toISOString(),
          end: s.timeRange?.end?.toISOString() || s.createdAt?.toISOString(),
        },
        metadata: s.metadata,
      }));

      const summaryTokens = summaries.reduce((sum, s) => sum + this.estimateTokens(s.content || ''), 0);
      context.meta.tokenEstimate += summaryTokens;
    }

    return context;
  }

  /**
   * Get skills relevant to a task using vector search when available
   */
  static async getRelevantSkills(podId, task, options = {}) {
    const { limit = 5, agentContext = null } = options;
    const visibilityFilter = PodAssetService.buildAgentScopeFilter(agentContext);

    // If no task, return most recent skills
    if (!task) {
      const query = PodAssetService.applyVisibilityFilter(
        { podId, type: 'skill' },
        visibilityFilter,
      );
      return PodAsset.find(query)
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();
    }

    // Try vector search first
    const vs = getVectorSearch();
    if (vs) {
      try {
        const results = await vs.search(podId, task, {
          limit,
          types: ['skill'],
          hybrid: true,
        });

        if (results && results.length > 0) {
          const assetIds = results.map((r) => r.asset_id);
          const baseQuery = PodAssetService.applyVisibilityFilter(
            { _id: { $in: assetIds } },
            visibilityFilter,
          );
          const skills = await PodAsset.find(baseQuery).lean();

          // Preserve search order and add relevance
          return assetIds
            .map((id) => {
              const skill = skills.find((s) => s._id.toString() === id);
              const result = results.find((r) => r.asset_id === id);
              return skill ? { ...skill, relevance: result?.combinedScore || 0 } : null;
            })
            .filter(Boolean);
        }
      } catch (error) {
        console.error('Skill vector search error:', error.message);
      }
    }

    // Fallback to keyword search
    const keywords = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const query = PodAssetService.applyVisibilityFilter(
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
  static async searchAssets(podId, query, options = {}) {
    const { limit = 10, types = null, maxTokens = 4000, agentContext = null } = options;
    const visibilityFilter = PodAssetService.buildAgentScopeFilter(agentContext);

    // Try vector search first
    const vs = getVectorSearch();
    if (vs) {
      try {
        const searchTypes = types || ['summary', 'integration-summary', 'doc', 'file', 'link', 'thread', 'daily-log'];
        const results = await vs.search(podId, query, {
          limit: limit * 2,
          types: searchTypes,
          hybrid: true,
        });

        if (results && results.length > 0) {
          // Fetch full assets for matched IDs
          const assetIds = [...new Set(results.map((r) => r.asset_id))];
          const assetsQuery = PodAssetService.applyVisibilityFilter(
            { _id: { $in: assetIds } },
            visibilityFilter,
          );
          const assets = await PodAsset.find(assetsQuery).lean();

          // Merge with relevance scores, respecting token budget
          let tokenCount = 0;
          const merged = [];

          for (let i = 0; i < results.length; i += 1) {
            const result = results[i];
            const asset = assets.find((a) => (
              a._id.toString() === result.asset_id
              && PodAssetService.isAssetVisible(a, agentContext)
            ));
            if (asset) {
              const assetTokens = this.estimateTokens(asset.content?.substring(0, 300) || '');
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
        console.error('Vector search error, falling back to keyword:', error.message);
      }
    }

    // Fallback to keyword search
    const searchQuery = PodAssetService.applyVisibilityFilter(
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

    const assets = await PodAsset.find(searchQuery).sort({ updatedAt: -1 }).limit(limit).lean();

    return assets.map((a) => ({
      ...a,
      relevance: this.calculateRelevance(a, keywords),
    }));
  }

  /**
   * Get recent summaries for a pod
   */
  static async getRecentSummaries(podId, options = {}) {
    const { hours = 24, limit = 5, types = null } = options;

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const query = {
      podId,
      createdAt: { $gte: since },
      type: { $ne: 'daily-digest' }, // Exclude daily digests by default
    };

    if (types) {
      query.type = { $in: types };
    }

    return Summary.find(query).sort({ createdAt: -1 }).limit(limit).lean();
  }

  /**
   * Read a memory file
   */
  static async readMemoryFile(podId, path, options = {}) {
    const { agentContext = null } = options;
    const normalizedAgent = PodAssetService.normalizeAgentContext(agentContext);
    // Handle special paths
    if (path === 'MEMORY.md') {
      let asset = null;
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

    if (path === 'SKILLS.md') {
      const skillsQuery = PodAssetService.applyVisibilityFilter(
        {
          podId,
          type: 'skill',
        },
        PodAssetService.buildAgentScopeFilter(agentContext),
      );
      const skills = await PodAsset.find(skillsQuery)
        .sort({ updatedAt: -1 })
        .lean();

      return this.formatSkillsAsMarkdown(skills);
    }

    if (path === 'CONTEXT.md') {
      const pod = await Pod.findById(podId).lean();
      return this.formatContextAsMarkdown(pod);
    }

    // Daily log: memory/YYYY-MM-DD.md
    const dateMatch = path.match(/^memory\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (dateMatch) {
      const date = dateMatch[1];
      let asset = null;
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

    // Generic asset lookup by path
    const assetQuery = PodAssetService.applyVisibilityFilter(
      {
        podId,
        title: path,
      },
      PodAssetService.buildAgentScopeFilter(agentContext),
    );
    const asset = await PodAsset.findOne(assetQuery).lean();

    if (!asset) {
      throw new Error(`Memory file not found: ${path}`);
    }

    return asset.content;
  }

  /**
   * Write to pod memory and index in vector search
   */
  static async writeMemory(podId, options) {
    const {
      target, content, tags = [], source = {},
    } = options;
    const agentContext = options.agentContext || null;
    // 'memory' target is a shared pod resource (task board) — always pod-scoped so all members can see it
    const scope = target === 'memory' ? 'pod' : (options.scope || (agentContext ? 'agent' : 'pod'));
    const normalizedAgent = PodAssetService.normalizeAgentContext(agentContext);
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

    // Helper to index asset in vector search
    const indexAsset = async (asset) => {
      const vs = getVectorSearch();
      if (vs) {
        try {
          await vs.indexAsset(podId, asset);
        } catch (e) {
          console.warn('Failed to index asset in vector search:', e.message);
        }
      }
    };

    if (target === 'daily') {
      // Append to today's daily log
      const today = new Date().toISOString().split('T')[0];
      const timestamp = new Date().toISOString().split('T')[1].substring(0, 5);

      const dailyQuery = PodAssetService.applyVisibilityFilter(
        {
          podId,
          type: 'daily-log',
          title: `${today}.md`,
        },
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

      // Append with timestamp
      const entry = `**${timestamp}** ${source.agent ? `(${source.agent})` : ''}\n${content}\n\n`;
      asset.content += entry;
      asset.tags = [...new Set([...asset.tags, ...tags])];
      asset.metadata = { ...(asset.metadata || {}), ...metadata };
      await asset.save();

      // Index in vector search
      await indexAsset(asset);

      return { success: true, assetId: asset._id.toString() };
    }

    if (target === 'memory') {
      // Update MEMORY.md
      const memoryQuery = PodAssetService.applyVisibilityFilter(
        {
          podId,
          type: 'memory',
          title: 'MEMORY.md',
        },
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

      // Replace memory (MEMORY.md is a living document, not a log)
      asset.content = content;
      asset.tags = [...new Set([...asset.tags, ...tags])];
      asset.metadata = { ...(asset.metadata || {}), ...metadata };
      await asset.save();

      // Index in vector search
      await indexAsset(asset);

      return { success: true, assetId: asset._id.toString() };
    }

    if (target === 'skill') {
      // Create a new skill
      const asset = new PodAsset({
        podId,
        type: 'skill',
        title: options.title || tags[0] || 'Untitled Skill',
        content,
        tags,
        sourceRef: source,
      });
      await asset.save();

      // Index in vector search
      await indexAsset(asset);

      return { success: true, assetId: asset._id.toString() };
    }

    throw new Error(`Unknown target: ${target}`);
  }

  /**
   * Estimate token count for text
   */
  static estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Calculate basic relevance score
   */
  static calculateRelevance(asset, keywords) {
    if (!keywords || keywords.length === 0) return 0.5;

    let score = 0;
    const titleLower = (asset.title || '').toLowerCase();
    const contentLower = (asset.content || '').toLowerCase();
    const tags = asset.tags || [];

    keywords.forEach((keyword) => {
      if (titleLower.includes(keyword)) score += 0.3;
      if (contentLower.includes(keyword)) score += 0.2;
      if (tags.some((t) => t.toLowerCase().includes(keyword))) score += 0.25;
    });

    return Math.min(score / keywords.length, 1);
  }

  /**
   * Format skills as markdown
   */
  static formatSkillsAsMarkdown(skills) {
    if (!skills || skills.length === 0) {
      return '# Pod Skills\n\nNo skills have been derived yet.';
    }

    let md = '# Pod Skills\n\n';
    md += `*${skills.length} skills derived from pod activity*\n\n`;

    skills.forEach((skill) => {
      md += `## ${skill.title}\n\n`;
      if (skill.tags?.length > 0) {
        md += `**Tags:** ${skill.tags.join(', ')}\n\n`;
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
  static formatContextAsMarkdown(pod) {
    if (!pod) {
      return '# Pod Context\n\nPod not found.';
    }

    let md = `# ${pod.name}\n\n`;

    if (pod.description) {
      md += `${pod.description}\n\n`;
    }

    md += `**Type:** ${pod.type}\n`;
    md += `**Members:** ${pod.members?.length || 0}\n\n`;

    return md;
  }
}

module.exports = ContextAssemblerService;
