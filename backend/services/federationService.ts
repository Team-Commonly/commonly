/**
 * Federation Service
 *
 * Handles cross-pod queries with explicit scope checking and audit logging.
 * All cross-pod access must go through this service.
 */

// eslint-disable-next-line global-require
const PodLink = require('../models/PodLink');
// eslint-disable-next-line global-require
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const ContextAssemblerService = require('./contextAssemblerService');
// eslint-disable-next-line global-require
const PodAssetService = require('./podAssetService');

interface QueryLinkedPodOptions {
  sourcePodId: unknown;
  targetPodId: unknown;
  queryType: string;
  filters?: Record<string, unknown>;
  actorId?: unknown;
  actorType?: string;
  limit?: number;
}

interface FederatedItem {
  _federated: boolean;
  _sourcePodId: string;
  [key: string]: unknown;
}

interface FederatedSearchOptions {
  sourcePodId: unknown;
  query: string;
  queryTypes?: string[];
  actorId?: unknown;
  actorType?: string;
  limit?: number;
}

interface LinkDoc {
  _id: unknown;
  scopes: Array<{ type: string; filters?: Record<string, unknown> }>;
  sourcePodId: { _id: unknown; name?: string; type?: string; description?: string };
  hasScope: (type: string, filters?: Record<string, unknown>) => boolean;
  recordQuery: (actorId: unknown, actorType: string, opts: Record<string, unknown>) => Promise<void>;
}

class FederationService {
  /**
   * Query a linked pod's resources
   */
  static async queryLinkedPod(options: QueryLinkedPodOptions): Promise<{
    results: unknown;
    meta: Record<string, unknown>;
  }> {
    const {
      sourcePodId,
      targetPodId,
      queryType,
      filters = {},
      actorId,
      actorType = 'human',
      limit = 10,
    } = options;

    // 1. Find active link
    const link: LinkDoc | null = await PodLink.findActiveLink(targetPodId, sourcePodId);
    if (!link) {
      throw new Error('No active link to target pod');
    }

    // 2. Check scope
    const scopeType = `${queryType}:read`;
    if (!link.hasScope(scopeType, filters)) {
      throw new Error(`Query exceeds granted scopes: ${scopeType}`);
    }

    // 3. Execute query based on type
    let results: unknown;
    let itemCount = 0;

    switch (queryType) {
      case 'summaries':
        results = await FederationService.querySummaries(targetPodId, filters, link, limit);
        itemCount = (results as unknown[]).length;
        break;

      case 'skills':
        results = await FederationService.querySkills(targetPodId, filters, link, limit);
        itemCount = (results as unknown[]).length;
        break;

      case 'assets':
        results = await FederationService.queryAssets(targetPodId, filters, link, limit);
        itemCount = (results as unknown[]).length;
        break;

      case 'memory':
        results = await FederationService.queryMemory(targetPodId, filters, link);
        itemCount = 1;
        break;

      case 'context':
        results = await FederationService.queryContext(targetPodId, filters, link);
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
        sourcePodId: String(sourcePodId),
        targetPodId: String(targetPodId),
        queryType,
        itemCount,
        link: {
          id: String(link._id),
          scopes: link.scopes,
        },
      },
    };
  }

  /**
   * Query summaries from linked pod
   */
  static async querySummaries(
    podId: unknown,
    filters: Record<string, unknown>,
    link: LinkDoc,
    limit: number,
  ): Promise<FederatedItem[]> {
    const query: Record<string, unknown> = { podId };

    const scope = link.scopes.find((s) => s.type === 'summaries:read');
    const scopeFilters = scope?.filters as Record<string, string[]> | undefined;
    if ((scopeFilters?.types || []).length > 0) {
      query.type = { $in: scopeFilters!.types };
    }
    if (scopeFilters?.since) {
      query.createdAt = { $gte: scopeFilters.since };
    }

    if (filters.type) {
      query.type = filters.type;
    }
    if (filters.since) {
      query.createdAt = { ...(query.createdAt as object), $gte: new Date(filters.since as string) };
    }

    const summaries = await Summary.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean() as Array<Record<string, unknown>>;

    return summaries.map((s) => ({
      id: String(s._id),
      type: s.type,
      content: s.content,
      period: s.timeRange,
      createdAt: s.createdAt,
      _federated: true,
      _sourcePodId: String(podId),
    }));
  }

  /**
   * Query skills from linked pod
   */
  static async querySkills(
    podId: unknown,
    filters: Record<string, unknown>,
    link: LinkDoc,
    limit: number,
  ): Promise<FederatedItem[]> {
    const query: Record<string, unknown> = PodAssetService.applyVisibilityFilter(
      { podId, type: 'skill' },
      PodAssetService.buildAgentScopeFilter(null),
    );

    const scope = link.scopes.find((s) => s.type === 'skills:read');
    const scopeFilters = scope?.filters as Record<string, string[]> | undefined;
    if ((scopeFilters?.tags || []).length > 0) {
      query.tags = { $in: scopeFilters!.tags };
    }

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
      .lean() as Array<Record<string, unknown>>;

    return skills.map((s) => ({
      id: String(s._id),
      name: s.title,
      instructions: s.content,
      tags: s.tags,
      createdAt: s.createdAt,
      _federated: true,
      _sourcePodId: String(podId),
    }));
  }

  /**
   * Query assets from linked pod
   */
  static async queryAssets(
    podId: unknown,
    filters: Record<string, unknown>,
    link: LinkDoc,
    limit: number,
  ): Promise<FederatedItem[]> {
    const query: Record<string, unknown> = PodAssetService.applyVisibilityFilter(
      { podId },
      PodAssetService.buildAgentScopeFilter(null),
    );

    const scope = link.scopes.find((s) => s.type === 'assets:read');
    const scopeFilters = scope?.filters as Record<string, string[]> | undefined;
    if ((scopeFilters?.types || []).length > 0) {
      query.type = { $in: scopeFilters!.types };
    }
    if ((scopeFilters?.tags || []).length > 0) {
      query.tags = { $in: scopeFilters!.tags };
    }

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
      .lean() as Array<Record<string, unknown>>;

    return assets.map((a) => ({
      id: String(a._id),
      title: a.title,
      type: a.type,
      snippet: (a.content as string)?.substring(0, 300),
      tags: a.tags,
      createdAt: a.createdAt,
      _federated: true,
      _sourcePodId: String(podId),
    }));
  }

  /**
   * Query memory from linked pod
   */
  static async queryMemory(
    podId: unknown,
    _filters: Record<string, unknown>,
    _link: LinkDoc,
  ): Promise<FederatedItem> {
    const content = await ContextAssemblerService.readMemoryFile(podId, 'MEMORY.md') as string;
    return {
      content,
      _federated: true,
      _sourcePodId: String(podId),
    };
  }

  /**
   * Query assembled context from linked pod
   */
  static async queryContext(
    podId: unknown,
    filters: Record<string, unknown>,
    link: LinkDoc,
  ): Promise<FederatedItem> {
    const options = {
      task: filters.task,
      includeMemory: link.hasScope('memory:read'),
      includeSkills: link.hasScope('skills:read'),
      includeSummaries: link.hasScope('summaries:read'),
      maxTokens: filters.maxTokens || 4000,
    };

    const context = await ContextAssemblerService.assembleContext(podId, options) as Record<string, unknown>;

    return {
      ...context,
      _federated: true,
      _sourcePodId: String(podId),
    };
  }

  /**
   * Get all accessible pods for a source pod (through links)
   */
  static async getAccessiblePods(podId: unknown): Promise<Array<{
    pod: { id: string; name?: string; type?: string; description?: string };
    scopes: LinkDoc['scopes'];
    linkId: string;
  }>> {
    const links = await PodLink.find({
      targetPodId: podId,
      status: 'active',
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    })
      .populate('sourcePodId', 'name type description')
      .lean() as LinkDoc[];

    return links.map((link) => ({
      pod: {
        id: String(link.sourcePodId._id),
        name: link.sourcePodId.name,
        type: link.sourcePodId.type,
        description: link.sourcePodId.description,
      },
      scopes: link.scopes,
      linkId: String(link._id),
    }));
  }

  /**
   * Search across all accessible pods
   */
  static async federatedSearch(options: FederatedSearchOptions): Promise<FederatedItem[]> {
    const {
      sourcePodId,
      query,
      queryTypes = ['skills', 'assets'],
      actorId,
      actorType,
      limit = 10,
    } = options;

    const accessiblePods = await FederationService.getAccessiblePods(sourcePodId);

    const allResults = (await Promise.all(
      accessiblePods.map(async ({ pod, scopes }) => {
        const perPodResults = await Promise.all(
          queryTypes.map(async (queryType) => {
            const scopeType = `${queryType}:read`;
            const hasScope = scopes.some((s) => s.type === scopeType);

            if (!hasScope) return [];

            try {
              const { results } = await FederationService.queryLinkedPod({
                sourcePodId,
                targetPodId: pod.id,
                queryType,
                filters: { search: query },
                actorId,
                actorType,
                limit: Math.ceil(limit / accessiblePods.length),
              });

              return (results as FederatedItem[]).map((r) => ({
                ...r,
                _sourcePod: pod,
              }));
            } catch (error) {
              console.error(`Federation search error for pod ${pod.id}:`, (error as Error).message);
              return [];
            }
          }),
        );

        return perPodResults.flat();
      }),
    )).flat();

    allResults.sort((a, b) => new Date((b as FederatedItem).createdAt as string).getTime() - new Date((a as FederatedItem).createdAt as string).getTime());

    return allResults.slice(0, limit);
  }
}

export default FederationService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
