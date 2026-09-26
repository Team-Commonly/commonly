// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const { manifests } = require('./manifests');
// eslint-disable-next-line global-require
const { isServerOwnedConfigKey } = require('../utils/serverOwnedConfigKeys');

interface ManifestEntry {
  id: string;
  requiredConfig: string[];
  configSchema: unknown;
  catalog: unknown;
}

interface CatalogEntry extends ManifestEntry {
  stats?: { activeIntegrations: number };
}

/**
 * The published contract is the manifest's completeness predicate MINUS the keys
 * a caller may not send. The predicate names server-owned keys by design (a bind
 * writes `botTokenRef`/`chatId`; the environment supplies `botToken`), so the
 * filter belongs here, at the publish site, rather than in the predicate: a
 * client that follows this payload must never be told to send a key the same
 * route refuses with `server_owned_config_key` (TASK-140, wren 74256).
 */
const publishedRequirement = (keys: string[] = []): string[] => (
  keys.filter((key) => !isServerOwnedConfigKey(key))
);

const publishedSchema = (schema: unknown): unknown => {
  if (!schema || typeof schema !== 'object') return schema || null;
  const shape = schema as { properties?: Record<string, unknown>; required?: unknown };
  const properties = shape.properties
    ? Object.fromEntries(Object.entries(shape.properties).filter(([key]) => !isServerOwnedConfigKey(key)))
    : undefined;
  return {
    ...(schema as Record<string, unknown>),
    ...(properties ? { properties } : {}),
    ...(Array.isArray(shape.required) ? { required: publishedRequirement(shape.required as string[]) } : {}),
  };
};

function getManifestEntries(): ManifestEntry[] {
  return Object.values(manifests as Record<string, ManifestEntry>).map((manifest) => ({
    id: manifest.id,
    requiredConfig: publishedRequirement(manifest.requiredConfig || []),
    configSchema: publishedSchema(manifest.configSchema),
    catalog: manifest.catalog || null,
  }));
}

async function buildCatalogEntries(params: { userId?: string }): Promise<CatalogEntry[]> {
  const { userId } = params;
  const manifestEntries = getManifestEntries();
  if (!userId) {
    return manifestEntries;
  }

  const pods = await Pod.find({ members: userId }).select('_id').lean() as Array<{ _id: unknown }>;
  const podIds = pods.map((pod) => pod._id);
  if (!podIds.length) {
    return manifestEntries;
  }

  const counts = await Integration.aggregate([
    {
      $match: {
        podId: { $in: podIds },
        isActive: true,
      },
    },
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 },
      },
    },
  ]) as Array<{ _id: string; count: number }>;

  const countsByType = counts.reduce<Record<string, number>>((acc, item) => ({
    ...acc,
    [item._id]: item.count,
  }), {});

  return manifestEntries.map((entry) => ({
    ...entry,
    stats: {
      activeIntegrations: countsByType[entry.id] || 0,
    },
  }));
}

module.exports = {
  getManifestEntries,
  buildCatalogEntries,
};

export {};
