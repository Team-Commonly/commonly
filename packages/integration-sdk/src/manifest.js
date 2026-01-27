const { ValidationError } = require('./errors');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build a minimal JSON Schema for a config object using required string fields.
 * This intentionally keeps the schema surface small and dependency-free.
 */
function buildConfigSchema(requiredFields = []) {
  const properties = {};
  for (const field of requiredFields) {
    properties[field] = { type: 'string', minLength: 1 };
  }
  return {
    type: 'object',
    additionalProperties: true,
    properties,
    required: [...requiredFields],
  };
}

/**
 * Validate the shape of an integration manifest.
 * The manifest is metadata-only; it should be safe to evaluate at config time.
 */
function validateManifest(manifest) {
  if (!isPlainObject(manifest)) {
    throw new ValidationError('Integration manifest must be an object');
  }

  if (!manifest.id || typeof manifest.id !== 'string') {
    throw new ValidationError('Integration manifest requires a string id');
  }

  if (
    manifest.requiredConfig !== undefined &&
    (!Array.isArray(manifest.requiredConfig)
      || manifest.requiredConfig.some((f) => typeof f !== 'string' || !f))
  ) {
    throw new ValidationError('manifest.requiredConfig must be an array of non-empty strings');
  }

  if (manifest.configSchema !== undefined && !isPlainObject(manifest.configSchema)) {
    throw new ValidationError('manifest.configSchema must be an object when provided');
  }

  if (manifest.catalog !== undefined && !isPlainObject(manifest.catalog)) {
    throw new ValidationError('manifest.catalog must be an object when provided');
  }

  return manifest;
}

/**
 * Ensure required config fields exist and are non-empty.
 * This is a pragmatic validator that complements (but does not fully implement) JSON Schema.
 */
function validateRequiredConfig(config, manifest) {
  const required = manifest?.requiredConfig || [];
  if (!required.length) return;

  const missing = required.filter((field) => {
    const value = config?.[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length) {
    throw new ValidationError(`Missing fields: ${missing.join(', ')}`, {
      missing,
      manifestId: manifest?.id,
    });
  }
}

/**
 * Validate a normalized message shape at runtime.
 * Returns a list of human-readable errors (empty when valid).
 */
function validateNormalizedMessage(message) {
  const errors = [];
  if (!isPlainObject(message)) {
    return ['normalized message must be an object'];
  }

  const requiredStringFields = [
    'source',
    'externalId',
    'authorId',
    'authorName',
    'content',
    'timestamp',
  ];

  for (const field of requiredStringFields) {
    if (!message[field] || typeof message[field] !== 'string') {
      errors.push(`missing string field: ${field}`);
    }
  }

  if (message.attachments !== undefined && !Array.isArray(message.attachments)) {
    errors.push('attachments must be an array when provided');
  }

  return errors;
}

module.exports = {
  buildConfigSchema,
  validateManifest,
  validateRequiredConfig,
  validateNormalizedMessage,
};

