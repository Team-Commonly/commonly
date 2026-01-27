const Integration = require('../models/Integration');
const Pod = require('../models/Pod');
const { manifests } = require('./manifests');

function getManifestEntries() {
  return Object.values(manifests).map((manifest) => ({
    id: manifest.id,
    requiredConfig: manifest.requiredConfig || [],
    configSchema: manifest.configSchema || null,
    catalog: manifest.catalog || null,
  }));
}

async function buildCatalogEntries({ userId }) {
  const manifestEntries = getManifestEntries();
  if (!userId) {
    return manifestEntries;
  }

  const pods = await Pod.find({ members: userId }).select('_id').lean();
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
  ]);

  const countsByType = counts.reduce((acc, item) => ({
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
