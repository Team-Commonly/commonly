const { IntegrationError } = require('./errors');

class IntegrationRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(type, factory) {
    if (!type || typeof factory !== 'function') {
      throw new IntegrationError('register() requires type and factory');
    }
    this.providers.set(type, factory);
  }

  /**
   * Get a provider instance for a given type.
   * @param {string} type
   * @param {object} config
   * @returns {object}
   */
  get(type, config) {
    const factory = this.providers.get(type);
    if (!factory) {
      throw new IntegrationError(`No provider registered for type: ${type}`);
    }
    return factory(config);
  }
}

const registry = new IntegrationRegistry();

module.exports = { IntegrationRegistry, registry };
