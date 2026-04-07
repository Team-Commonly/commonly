// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const { manifests } = require('./manifests');

interface ManifestEntry {
  id: string;
  requiredConfig: string[];
  configSchema: unknown;
  catalog: unknown;
}

interface CatalogEntry extends ManifestEntry {
  stats?: { activeIntegrations: number };
}

function getManifestEntries(): ManifestEntry[] {
  return Object.values(manifests as Record<string, ManifestEntry>).map((manifest) => ({
    id: manifest.id,
    requiredConfig: manifest.requiredConfig || [],
    configSchema: manifest.configSchema || null,
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
