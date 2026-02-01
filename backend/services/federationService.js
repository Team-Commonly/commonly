/**
 * Federation Service
 *
 * Handles cross-pod queries with explicit scope checking and audit logging.
 * All cross-pod access must go through this service.
 */

const PodLink = require('../models/PodLink');
const PodAsset = require('../models/PodAsset');
const Summary = require('../models/Summary');
const Pod = require('../models/Pod');
const ContextAssemblerService = require('./contextAssemblerService');
const PodAssetService = require('./podAssetService');

class FederationService {
  /**
   * Query a linked pod's resources
   */
  static async queryLinkedPod(options) {
    const {
      sourcePodId, // Pod making the query
      targetPodId, // Pod being queried
      queryType, // 'summaries', 'skills', 'assets', 'memory', 'context'
      filters = {},
      actorId,
      actorType = 'human',
      limit = 10,
    } = options;

    // 1. Find active link
    const link = await PodLink.findActiveLink(targetPodId, sourcePodId);
    if (!link) {
      throw new Error('No active link to target pod');
    }

    // 2. Check scope
    const scopeType = `${queryType}:read`;
    if (!link.hasScope(scopeType, filters)) {
      throw new Error(`Query exceeds granted scopes: ${scopeType}`);
    }

    // 3. Execute query based on type
    let results;
    let itemCount = 0;

    switch (queryType) {
      case 'summaries':
        results = await this.querySummaries(targetPodId, filters, link, limit);
        itemCount = results.length;
        break;

      case 'skills':
        results = await this.querySkills(targetPodId, filters, link, limit);
        itemCount = results.length;
        break;

      case 'assets':
        results = await this.queryAssets(targetPodId, filters, link, limit);
        itemCount = results.length;
        break;

      case 'memory':
        results = await this.queryMemory(targetPodId, filters, link);
        itemCount = 1;
        break;

      case 'context':
        results = await this.queryContext(targetPodId, filters, link);
        itemCount = 1;
        break;

      default:
        throw new Error(`Unknown query type: ${queryType}`);
    }

    // 4. Audit log
    await link.recordQuery(actorId, actorType, {
      queryType,
      filters,
      itemCount,
    });

    return {
      results,
      meta: {
        sourcePodId: sourcePodId.toString(),
        targetPodId: targetPodId.toString(),
        queryType,
        itemCount,
        link: {
          id: link._id.toString(),
          scopes: link.scopes,
        },
      },
    };
  }

  /**
   * Query summaries from linked pod
   */
  static async querySummaries(podId, filters, link, limit) {
    const query = { podId };

    // Apply scope filters
    const scope = link.scopes.find((s) => s.type === 'summaries:read');
    if (scope?.filters?.types?.length > 0) {
      query.type = { $in: scope.filters.types };
    }
    if (scope?.filters?.since) {
      query.createdAt = { $gte: scope.filters.since };
    }

    // Apply request filters
    if (filters.type) {
      query.type = filters.type;
    }
    if (filters.since) {
      query.createdAt = { ...query.createdAt, $gte: new Date(filters.since) };
    }

    const summaries = await Summary.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return summaries.map((s) => ({
      id: s._id.toString(),
      type: s.type,
      content: s.content,
      period: s.timeRange,
      createdAt: s.createdAt,
      // Mark as federated
      _federated: true,
      _sourcePodId: podId.toString(),
    }));
  }

  /**
   * Query skills from linked pod
   */
  static async querySkills(podId, filters, link, limit) {
    const query = PodAssetService.applyVisibilityFilter(
      { podId, type: 'skill' },
      PodAssetService.buildAgentScopeFilter(null),
    );

    // Apply scope filters
    const scope = link.scopes.find((s) => s.type === 'skills:read');
    if (scope?.filters?.tags?.length > 0) {
      query.tags = { $in: scope.filters.tags };
    }

    // Apply request filters
    if (filters.tags) {
      query.tags = { $in: Array.isArray(filters.tags) ? filters.tags : [filters.tags] };
    }
    if (filters.search) {
      query.$or = [
        { title: { $regex: filters.search, $options: 'i' } },
        { content: { $regex: filters.search, $options: 'i' } },
      ];
    }

    const skills = await PodAsset.find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    return skills.map((s) => ({
      id: s._id.toString(),
      name: s.title,
      instructions: s.content,
      tags: s.tags,
      createdAt: s.createdAt,
      _federated: true,
      _sourcePodId: podId.toString(),
    }));
  }

  /**
   * Query assets from linked pod
   */
  static async queryAssets(podId, filters, link, limit) {
    const query = PodAssetService.applyVisibilityFilter(
      { podId },
      PodAssetService.buildAgentScopeFilter(null),
    );

    // Apply scope filters
    const scope = link.scopes.find((s) => s.type === 'assets:read');
    if (scope?.filters?.types?.length > 0) {
      query.type = { $in: scope.filters.types };
    }
    if (scope?.filters?.tags?.length > 0) {
      query.tags = { $in: scope.filters.tags };
    }

    // Apply request filters
    if (filters.type) {
      query.type = filters.type;
    }
    if (filters.search) {
      query.$or = [
        { title: { $regex: filters.search, $options: 'i' } },
        { content: { $regex: filters.search, $options: 'i' } },
      ];
    }

    const assets = await PodAsset.find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    return assets.map((a) => ({
      id: a._id.toString(),
      title: a.title,
      type: a.type,
      snippet: a.content?.substring(0, 300),
      tags: a.tags,
      createdAt: a.createdAt,
      _federated: true,
      _sourcePodId: podId.toString(),
    }));
  }

  /**
   * Query memory from linked pod
   */
  static async queryMemory(podId, filters, link) {
    const content = await ContextAssemblerService.readMemoryFile(podId, 'MEMORY.md');
    return {
      content,
      _federated: true,
      _sourcePodId: podId.toString(),
    };
  }

  /**
   * Query assembled context from linked pod
   */
  static async queryContext(podId, filters, link) {
    // Build options based on scopes
    const options = {
      task: filters.task,
      includeMemory: link.hasScope('memory:read'),
      includeSkills: link.hasScope('skills:read'),
      includeSummaries: link.hasScope('summaries:read'),
      maxTokens: filters.maxTokens || 4000,
    };

    const context = await ContextAssemblerService.assembleContext(podId, options);

    return {
      ...context,
      _federated: true,
      _sourcePodId: podId.toString(),
    };
  }

  /**
   * Get all accessible pods for a source pod (through links)
   */
  static async getAccessiblePods(podId) {
    const links = await PodLink.find({
      targetPodId: podId,
      status: 'active',
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    })
      .populate('sourcePodId', 'name type description')
      .lean();

    return links.map((link) => ({
      pod: {
        id: link.sourcePodId._id.toString(),
        name: link.sourcePodId.name,
        type: link.sourcePodId.type,
        description: link.sourcePodId.description,
      },
      scopes: link.scopes,
      linkId: link._id.toString(),
    }));
  }

  /**
   * Search across all accessible pods
   */
  static async federatedSearch(options) {
    const {
      sourcePodId,
      query,
      queryTypes = ['skills', 'assets'],
      actorId,
      actorType,
      limit = 10,
    } = options;

    // Get all accessible pods
    const accessiblePods = await this.getAccessiblePods(sourcePodId);

    // Search each pod
    const allResults = (await Promise.all(
      accessiblePods.map(async ({ pod, scopes }) => {
        const perPodResults = await Promise.all(
          queryTypes.map(async (queryType) => {
            // Check if we have scope for this query type
            const scopeType = `${queryType}:read`;
            const hasScope = scopes.some((s) => s.type === scopeType);

            if (!hasScope) return [];

            try {
              const { results } = await this.queryLinkedPod({
                sourcePodId,
                targetPodId: pod.id,
                queryType,
                filters: { search: query },
                actorId,
                actorType,
                limit: Math.ceil(limit / accessiblePods.length),
              });

              return results.map((r) => ({
                ...r,
                _sourcePod: pod,
              }));
            } catch (error) {
              console.error(`Federation search error for pod ${pod.id}:`, error.message);
              return [];
            }
          }),
        );

        return perPodResults.flat();
      }),
    )).flat();

    // Sort by relevance/date and limit
    allResults.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return allResults.slice(0, limit);
  }
}

module.exports = FederationService;
