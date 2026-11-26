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

/**
 * The Installable key for a registry row, or null when the row has no usable
 * name. String(null) would key a nameless row "null", and every other
 * nameless row would then collide on it, so callers skip these instead.
 */
export function registryKeyOf(row: Obj | null | undefined): string | null {
  const name = row?.agentName;
  if (typeof name !== 'string' || !name.trim()) return null;
  return name.toLowerCase();
}

/**
 * The catalog display fields: what the read path may serve from Installable
 * (registryReader) and what refreshBridgeRow keeps current on a backfilled
 * row. One list so the two can't drift apart. `verified` and `status` are
 * gates, never display fields.
 */
export type DisplayField =
  | 'displayName' | 'description' | 'iconUrl' | 'latestVersion'
  | 'categories' | 'tags' | 'contextRequired';

export const DISPLAY_FIELDS: readonly DisplayField[] = [
  'displayName', 'description', 'iconUrl', 'latestVersion',
  'categories', 'tags', 'contextRequired',
];

/**
 * The Installable paths `installableToRegistryView` reads for each display
 * field: `top` on the document, `agent` on its agent component. Categories
 * need both, because the view prefers registryRow.categories over the
 * marketplace category and also uses it to split tags.
 */
export const DISPLAY_FIELD_PATHS: Readonly<Record<DisplayField, { top?: string[]; agent?: string[] }>> = {
  displayName: { top: ['name'] },
  description: { top: ['description'] },
  iconUrl: { agent: ['persona.avatar'] },
  latestVersion: { top: ['version'] },
  categories: { top: ['marketplace.category'], agent: ['metadata.registryRow.categories'] },
  tags: { top: ['marketplace.tags'] },
  contextRequired: { top: ['requires'] },
};

const getPath = (o: Obj | undefined, path: string): unknown => path
  .split('.')
  .reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Obj)[key] : undefined), o);

// Empty, null and missing are one value: a '' avatar is not a change from none.
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(Array.isArray(b) ? b : []);
  }
  const norm = (v: unknown) => (v === null || v === undefined ? '' : v);
  return norm(a) === norm(b);
};

/**
 * The display-path `$set` that would bring `doc` in line with `mapped` (a
 * registryToInstallable result), split into document paths and agent
 * component paths. Empty objects mean nothing differs. A missing value is
 * written as '' or [], never unset.
 */
export function bridgeDisplayDiff(mapped: Obj, doc: Obj): { top: Obj; agent: Obj } {
  const want = plain(mapped);
  const have = plain(doc);
  const wantAgent = (want.components || []).find((c: Obj) => c?.type === 'agent');
  const haveAgent = (have.components || []).find((c: Obj) => c?.type === 'agent');
  const top: Obj = {};
  const agent: Obj = {};
  const fill = (path: string, next: unknown, current: unknown, out: Obj) => {
    if (sameValue(next, current)) return;
    out[path] = next === undefined || next === null ? (Array.isArray(current) ? [] : '') : next;
  };
  DISPLAY_FIELDS.forEach((field) => {
    const { top: topPaths = [], agent: agentPaths = [] } = DISPLAY_FIELD_PATHS[field];
    topPaths.forEach((p) => fill(p, getPath(want, p), getPath(have, p), top));
    // A row with no agent component has nowhere to put these.
    if (haveAgent) agentPaths.forEach((p) => fill(p, getPath(wantAgent, p), getPath(haveAgent, p), agent));
  });
  return { top, agent };
}

export function registryToInstallable(input: Obj): Obj {
  const row = plain(input);
  const manifest = row.manifest || {};
  const runtime = manifest.runtime || {};
  const agentName = registryKeyOf(row);
  if (!agentName) throw new Error('AgentRegistry row has no agentName');
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
