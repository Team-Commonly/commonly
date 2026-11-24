/**
 * AgentRegistry <-> Installable mapping (ADR-001 Phase 3, step 5).
 *
 * Pure functions, no I/O. `registryToInstallable` is what the drift sweep and
 * the write-path mirrors insert; `installableToRegistryView` gives the
 * AgentRegistry-shaped fields the install route, the catalog and pod-agents
 * read, so the read switch can swap tables without touching those readers.
 * Field map and rules: docs/architecture/installable-registry-bridge.md.
 */

import { REGISTRY_BACKFILL_ORIGIN } from './registryBackfillOrigin';
import type { ComponentRuntime } from '../../models/Installable';

type Obj = Record<string, any>;

const COMPONENT_RUNTIMES: readonly ComponentRuntime[] = [
  'native', 'moltbot', 'webhook', 'claude-code', 'managed-agents', 'internal', 'remote',
];

const SOURCE_BY_REGISTRY: Record<string, 'builtin' | 'marketplace' | 'user'> = {
  'commonly-official': 'builtin',
  'commonly-community': 'marketplace',
  private: 'user',
};

const REGISTRY_BY_SOURCE: Record<string, string> = {
  builtin: 'commonly-official',
  marketplace: 'commonly-community',
  user: 'private',
};

const plain = (row: Obj): Obj => (typeof row?.toObject === 'function' ? row.toObject() : row);

// Mixed fields keep explicit undefineds as nulls; drop them instead.
const compact = (o: Obj): Obj => Object.fromEntries(
  Object.entries(o).filter(([, v]) => v !== undefined),
);

/**
 * The ADR-022 boundary: browse may only ever list a row the catalog already
 * treats as hireable. Smoke seats and internal wrappers are unverified, and an
 * ephemeral row belongs to one installer.
 */
export const isPublishable = (row: Obj): boolean => (
  row.verified === true && (row.status || 'active') === 'active' && row.ephemeral !== true
);

export function registryToInstallable(input: Obj): Obj {
  const row = plain(input);
  const manifest = row.manifest || {};
  const runtime = manifest.runtime || {};
  const agentName = String(row.agentName).toLowerCase();
  const version = row.latestVersion || manifest.version || '1.0.0';
  const displayName = row.displayName || agentName;
  const source = row.ephemeral === true ? 'user' : (SOURCE_BY_REGISTRY[row.registry] || 'marketplace');
  const categories: string[] = Array.isArray(row.categories) ? row.categories : [];
  const tags: string[] = Array.from(new Set([
    ...categories.slice(1),
    ...(Array.isArray(row.tags) ? row.tags : []),
  ]));
  const stats = row.stats || {};
  const fallbackPublishedAt = row.createdAt || row.updatedAt || new Date(0);
  const versions = (Array.isArray(row.versions) ? row.versions : [])
    .filter((v: Obj) => v && v.version)
    .map((v: Obj) => compact({
      version: v.version,
      publishedAt: v.publishedAt || fallbackPublishedAt,
      deprecated: v.deprecated,
      deprecationReason: v.deprecationReason,
    }));
  const runtimeType = typeof runtime.runtimeType === 'string' ? runtime.runtimeType : undefined;
  const componentRuntime = COMPONENT_RUNTIMES.includes(runtimeType as ComponentRuntime)
    ? runtimeType : undefined;
  const description = row.description || displayName;

  return compact({
    installableId: agentName,
    name: displayName,
    description,
    version,
    kind: 'agent',
    source,
    scope: source === 'builtin' ? 'instance' : 'pod',
    requires: manifest.context?.required || [],
    components: [compact({
      name: agentName,
      type: 'agent',
      version,
      description,
      runtime: componentRuntime,
      persona: compact({ displayName, avatar: row.iconUrl || undefined }),
      metadata: {
        // Manifest fields Installable has no column for, kept so the view can
        // return them; registryRow keeps what source/tags cannot round-trip.
        // defaultInstructions is left out: detail and fork expose metadata.
        registryManifest: compact({
          runtimeType,
          runtimeShape: compact({ type: runtime.type, connection: runtime.connection }),
          contextOptional: manifest.context?.optional,
          capabilities: manifest.capabilities,
        }),
        registryRow: compact({
          registry: row.registry,
          ephemeral: row.ephemeral === true,
          categories,
          weeklyInstalls: stats.weeklyInstalls || 0,
        }),
      },
    })],
    marketplace: {
      published: isPublishable(row),
      category: categories[0] || '',
      tags,
      verified: row.verified === true,
      rating: stats.rating || 0,
      ratingCount: stats.ratingCount || 0,
      installCount: stats.installs || 0,
    },
    owner: source === 'user' ? row.publisher?.userId : undefined,
    publisher: row.publisher && Object.keys(compact(row.publisher)).length
      ? compact({
        userId: row.publisher.userId,
        organizationId: row.publisher.organizationId,
        name: row.publisher.name,
      })
      : undefined,
    status: row.status || 'active',
    origin: REGISTRY_BACKFILL_ORIGIN,
    versions: versions.length ? versions : undefined,
    readme: row.readme,
    stats: { totalInstalls: stats.installs || 0, activeInstalls: 0, forkCount: 0 },
  });
}

/**
 * The AgentRegistry fields the read sites use (install.ts, catalog.ts,
 * pod-agents.ts, templates.ts, personaHireService), from an Installable that
 * was backfilled, dual-written by marketplace publish, or seeded natively.
 */
export function installableToRegistryView(input: Obj): Obj {
  const doc = plain(input);
  const components: Obj[] = doc.components || [];
  const agent = components.find((c) => c.type === 'agent') || {};
  const rm: Obj = agent.metadata?.registryManifest || {};
  const rr: Obj = agent.metadata?.registryRow || {};
  const market: Obj = doc.marketplace || {};
  const categories: string[] = rr.categories
    || (market.category ? [market.category] : []);
  const extraCategories = new Set(categories.slice(1));
  const stats: Obj = doc.stats || {};
  const runtimeShape: Obj = rm.runtimeShape || {};

  return {
    agentName: doc.installableId,
    displayName: doc.name,
    description: doc.description,
    readme: doc.readme,
    latestVersion: doc.version,
    versions: (doc.versions || []).map((v: Obj) => compact({
      version: v.version,
      publishedAt: v.publishedAt,
      deprecated: v.deprecated,
      deprecationReason: v.deprecationReason,
    })),
    manifest: compact({
      name: doc.installableId,
      version: doc.version,
      description: doc.description,
      // Same fallback marketplace publish writes to AgentRegistry.
      capabilities: rm.capabilities
        || components.map((c) => ({ name: c.name, description: c.description || c.name })),
      context: { required: doc.requires || [], optional: rm.contextOptional || [] },
      runtime: compact({
        type: runtimeShape.type || 'standalone',
        connection: runtimeShape.connection,
        runtimeType: rm.runtimeType || agent.runtime,
      }),
    }),
    status: doc.status,
    registry: rr.registry || REGISTRY_BY_SOURCE[doc.source] || 'commonly-community',
    ephemeral: rr.ephemeral === true,
    verified: market.verified === true,
    publisher: doc.publisher,
    categories,
    tags: (market.tags || []).filter((t: string) => !extraCategories.has(t)),
    stats: {
      installs: stats.totalInstalls || 0,
      weeklyInstalls: rr.weeklyInstalls || 0,
      rating: market.rating || 0,
      ratingCount: market.ratingCount || 0,
    },
    iconUrl: agent.persona?.avatar,
  };
}
