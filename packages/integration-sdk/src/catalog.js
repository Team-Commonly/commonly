const { ValidationError } = require('./errors');
const { validateManifest } = require('./manifest');

class IntegrationCatalog {
  constructor() {
    this.entries = new Map();
  }

  register(manifest) {
    const validated = validateManifest(manifest);
    if (!validated.catalog) {
      throw new ValidationError(
        `manifest.catalog is required to register catalog entry: ${validated.id}`,
      );
    }
    this.entries.set(validated.id, validated);
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  list() {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      requiredConfig: entry.requiredConfig || [],
      configSchema: entry.configSchema || null,
      catalog: entry.catalog,
    }));
  }
}

const catalog = new IntegrationCatalog();

module.exports = { IntegrationCatalog, catalog };

