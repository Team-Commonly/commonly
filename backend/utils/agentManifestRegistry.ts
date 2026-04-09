const AGENT_NAME_PATTERN = /^[a-z0-9-]+$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const SLUG_PATTERN = /^[a-z0-9-]+$/;
const SCOPE_PATTERN = /^[a-z0-9:_-]+$/i;
const MEMORY_PATTERN = /^\d+(?:\.\d+)?(?:kb|mb|gb|tb)$/i;

class ManifestValidationError extends Error {
  details: any;
  constructor(details: any) {
    super('Invalid agent manifest');
    this.name = 'ManifestValidationError';
    this.details = details;
  }
}

const isPlainObject = (value: any) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const addError = (details: any, field: any, message: any) => {
  details.push({ field, message });
};

const normalizeString = (value: any, {
  trim = true,
  maxLength = 200,
} = {}) => {
  if (typeof value !== 'string') return '';
  const nextValue = trim ? value.trim() : value;
  if (!nextValue) return '';
  return nextValue.slice(0, maxLength);
};

const normalizeSlugList = (value: any, field: any, details: any, maxItems = 20) => {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    addError(details, field, 'Must be an array of lowercase slugs');
    return [];
  }

  const seen = new Set();
  const normalized: any[] = [];

  value.forEach((entry: any, index: any) => {
    const nextValue = normalizeString(entry, { maxLength: 64 }).toLowerCase();
    if (!nextValue) return;
    if (!SLUG_PATTERN.test(nextValue)) {
      addError(details, `${field}[${index}]`, 'Must contain only lowercase letters, numbers, and hyphens');
      return;
    }
    if (seen.has(nextValue)) return;
    seen.add(nextValue);
    if (normalized.length < maxItems) normalized.push(nextValue);
  });

  if (value.length > maxItems) {
    addError(details, field, `Must not contain more than ${maxItems} entries`);
  }

  return normalized;
};

const normalizeScopeList = (value: any, field: any, details: any, maxItems = 50) => {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    addError(details, field, 'Must be an array of scope strings');
    return [];
  }

  const seen = new Set();
  const normalized: any[] = [];

  value.forEach((entry: any, index: any) => {
    const nextValue = normalizeString(entry, { maxLength: 100 });
    if (!nextValue) return;
    if (!SCOPE_PATTERN.test(nextValue)) {
      addError(details, `${field}[${index}]`, 'Must be a valid scope string');
      return;
    }
    if (seen.has(nextValue)) return;
    seen.add(nextValue);
    if (normalized.length < maxItems) normalized.push(nextValue);
  });

  if (value.length > maxItems) {
    addError(details, field, `Must not contain more than ${maxItems} entries`);
  }

  return normalized;
};

const normalizeStringList = (value: any, field: any, details: any, {
  maxItems = 50,
  maxLength = 100,
} = {}) => {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    addError(details, field, 'Must be an array of strings');
    return [];
  }

  const seen = new Set();
  const normalized: any[] = [];

  value.forEach((entry: any) => {
    const nextValue = normalizeString(entry, { maxLength });
    if (!nextValue) return;
    if (seen.has(nextValue)) return;
    seen.add(nextValue);
    if (normalized.length < maxItems) normalized.push(nextValue);
  });

  if (value.length > maxItems) {
    addError(details, field, `Must not contain more than ${maxItems} entries`);
  }

  return normalized;
};

const normalizeUrl = (value: any, field: any, details: any) => {
  const nextValue = normalizeString(value, { maxLength: 500 });
  if (!nextValue) return '';

  try {
    const parsed = new URL(nextValue);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      addError(details, field, 'Must use http or https');
      return '';
    }
    return parsed.toString();
  } catch (error) {
    addError(details, field, 'Must be a valid URL');
    return '';
  }
};

const normalizeCapabilities = (value: any, details: any) => {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    addError(details, 'manifest.capabilities', 'Must be an array');
    return [];
  }

  const seen = new Set();
  const normalized: any[] = [];

  value.forEach((entry: any, index: any) => {
    if (!isPlainObject(entry)) {
      addError(details, `manifest.capabilities[${index}]`, 'Must be an object');
      return;
    }
    const name = normalizeString(entry.name, { maxLength: 80 });
    if (!name) {
      addError(details, `manifest.capabilities[${index}].name`, 'Capability name is required');
      return;
    }
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    normalized.push({
      name,
      ...(normalizeString(entry.description, { maxLength: 200 }) ? {
        description: normalizeString(entry.description, { maxLength: 200 }),
      } : {}),
    });
  });

  if (value.length > 50) {
    addError(details, 'manifest.capabilities', 'Must not contain more than 50 entries');
  }

  return normalized;
};

const normalizeRuntime = (value: any, details: any) => {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    addError(details, 'manifest.runtime', 'Must be an object');
    return null;
  }

  const runtime: any = {};
  const type = normalizeString(value.type, { maxLength: 40 });
  if (type) {
    if (!['standalone', 'commonly-hosted', 'hybrid'].includes(type)) {
      addError(details, 'manifest.runtime.type', 'Must be standalone, commonly-hosted, or hybrid');
    } else {
      runtime.type = type;
    }
  }

  const connection = normalizeString(value.connection, { maxLength: 40 });
  if (connection) {
    if (!['mcp', 'rest', 'websocket'].includes(connection)) {
      addError(details, 'manifest.runtime.connection', 'Must be mcp, rest, or websocket');
    } else {
      runtime.connection = connection;
    }
  }

  const minMemory = normalizeString(value.minMemory, { maxLength: 40 });
  if (minMemory) {
    if (!MEMORY_PATTERN.test(minMemory)) {
      addError(details, 'manifest.runtime.minMemory', 'Must look like 512MB or 1GB');
    } else {
      runtime.minMemory = minMemory.toUpperCase();
    }
  }

  if (value.ports != null) {
    if (!isPlainObject(value.ports)) {
      addError(details, 'manifest.runtime.ports', 'Must be an object keyed by port name');
    } else {
      const ports: any = {};
      Object.entries(value.ports).forEach(([key, portValue]) => {
        const portName = normalizeString(key, { maxLength: 50 });
        const portNumber = Number(portValue);
        if (!portName) {
          addError(details, 'manifest.runtime.ports', 'Port names are required');
          return;
        }
        if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
          addError(details, `manifest.runtime.ports.${portName}`, 'Must be an integer between 1 and 65535');
          return;
        }
        ports[portName] = portNumber;
      });
      if (Object.keys(ports).length) runtime.ports = ports;
    }
  }

  return Object.keys(runtime).length ? runtime : null;
};

const normalizeHooks = (value: any, details: any) => {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    addError(details, 'manifest.hooks', 'Must be an object');
    return null;
  }

  const hooks: any = {};
  ['postInstall', 'preUpdate', 'postUpdate'].forEach((field) => {
    const nextValue = normalizeString(value[field], { maxLength: 200 });
    if (nextValue) hooks[field] = nextValue;
  });

  return Object.keys(hooks).length ? hooks : null;
};

const normalizeManifest = (input: any, details: any) => {
  if (!isPlainObject(input)) {
    addError(details, 'manifest', 'Manifest must be an object');
    return null;
  }

  const name = normalizeString(input.name, { maxLength: 100 }).toLowerCase();
  if (!name) {
    addError(details, 'manifest.name', 'Name is required');
  } else if (!AGENT_NAME_PATTERN.test(name)) {
    addError(details, 'manifest.name', 'Must contain only lowercase letters, numbers, and hyphens');
  }

  const version = normalizeString(input.version, { maxLength: 40 });
  if (!version) {
    addError(details, 'manifest.version', 'Version is required');
  } else if (!SEMVER_PATTERN.test(version)) {
    addError(details, 'manifest.version', 'Must be a valid semantic version');
  }

  const manifest: any = {
    name,
    version,
  };

  const description = normalizeString(input.description, { maxLength: 500 });
  if (description) manifest.description = description;

  const author = normalizeString(input.author, { maxLength: 120 });
  if (author) manifest.author = author;

  const license = normalizeString(input.license, { maxLength: 80 });
  if (license) manifest.license = license;

  const homepage = normalizeUrl(input.homepage, 'manifest.homepage', details);
  if (homepage) manifest.homepage = homepage;

  const repository = normalizeUrl(input.repository, 'manifest.repository', details);
  if (repository) manifest.repository = repository;

  const capabilities = normalizeCapabilities(input.capabilities, details);
  if (capabilities.length) manifest.capabilities = capabilities;

  if (input.context != null) {
    if (!isPlainObject(input.context)) {
      addError(details, 'manifest.context', 'Must be an object');
    } else {
      const required = normalizeScopeList(input.context.required, 'manifest.context.required', details);
      const optional = normalizeScopeList(input.context.optional, 'manifest.context.optional', details);
      if (required.length || optional.length) {
        manifest.context = {};
        if (required.length) manifest.context.required = required;
        if (optional.length) manifest.context.optional = optional;
      }
    }
  }

  if (input.integrations != null) {
    if (!isPlainObject(input.integrations)) {
      addError(details, 'manifest.integrations', 'Must be an object');
    } else {
      const supported = normalizeSlugList(input.integrations.supported, 'manifest.integrations.supported', details, 30);
      const required = normalizeSlugList(input.integrations.required, 'manifest.integrations.required', details, 30);
      if (required.some((entry) => !supported.includes(entry))) {
        addError(details, 'manifest.integrations.required', 'Required integrations must also appear in supported');
      }
      if (supported.length || required.length) {
        manifest.integrations = {};
        if (supported.length) manifest.integrations.supported = supported;
        if (required.length) manifest.integrations.required = required;
      }
    }
  }

  if (input.models != null) {
    if (!isPlainObject(input.models)) {
      addError(details, 'manifest.models', 'Must be an object');
    } else {
      const supported = normalizeStringList(input.models.supported, 'manifest.models.supported', details, {
        maxItems: 30,
        maxLength: 80,
      });
      const recommended = normalizeString(input.models.recommended, { maxLength: 80 });
      if (recommended && supported.length && !supported.includes(recommended)) {
        addError(details, 'manifest.models.recommended', 'Recommended model must appear in supported');
      }
      if (supported.length || recommended) {
        manifest.models = {};
        if (supported.length) manifest.models.supported = supported;
        if (recommended) manifest.models.recommended = recommended;
      }
    }
  }

  const runtime = normalizeRuntime(input.runtime, details);
  if (runtime) manifest.runtime = runtime;

  if (input.configSchema != null) {
    if (typeof input.configSchema === 'boolean' || isPlainObject(input.configSchema)) {
      manifest.configSchema = input.configSchema;
    } else {
      addError(details, 'manifest.configSchema', 'Must be a JSON object or boolean');
    }
  }

  const hooks = normalizeHooks(input.hooks, details);
  if (hooks) manifest.hooks = hooks;

  return manifest;
};

const normalizePublishPayload = (payload: any = {}) => {
  const details: any[] = [];
  if (!isPlainObject(payload)) {
    throw new ManifestValidationError([{ field: 'body', message: 'Request body must be an object' }]);
  }

  const manifest = normalizeManifest(payload.manifest, details);
  const displayName = normalizeString(payload.manifest?.displayName, { maxLength: 100 })
    || manifest?.name
    || '';
  const readme = payload.readme == null ? null : normalizeString(payload.readme, {
    trim: false,
    maxLength: 50000,
  });
  const categories = normalizeSlugList(payload.manifest?.categories, 'manifest.categories', details, 20);
  const tags = normalizeSlugList(payload.manifest?.tags, 'manifest.tags', details, 30);

  if (payload.readme != null && typeof payload.readme !== 'string') {
    addError(details, 'readme', 'Must be a string');
  }

  if (details.length) {
    throw new ManifestValidationError(details);
  }

  return {
    manifest,
    displayName,
    readme,
    categories,
    tags,
  };
};

module.exports = {
  ManifestValidationError,
  normalizePublishPayload,
};

export {};
