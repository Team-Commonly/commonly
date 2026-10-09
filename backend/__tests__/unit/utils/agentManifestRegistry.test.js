const {
  ManifestValidationError,
  normalizePublishPayload,
} = require('../../../utils/agentManifestRegistry');

describe('agent manifest registry payload normalization', () => {
  it('normalizes and sanitizes a valid publish payload', () => {
    const payload = normalizePublishPayload({
      manifest: {
        name: '  Valid-Agent  ',
        displayName: '  Valid Agent  ',
        version: '1.2.3',
        description: ' Registry-safe manifest ',
        homepage: 'https://example.com/docs',
        repository: 'https://github.com/acme/valid-agent',
        categories: ['support', 'support', 'ops'],
        tags: ['chat', 'chat', 'automation'],
        capabilities: [
          { name: ' Summarize ', description: ' Summaries ' },
          { name: 'Summarize', description: 'duplicate' },
        ],
        context: {
          required: ['messages:write', 'messages:write'],
          optional: ['context:read'],
        },
        integrations: {
          supported: ['discord', 'slack', 'discord'],
          required: ['discord'],
        },
        models: {
          supported: ['gpt-5-mini', 'gpt-5-mini', 'gpt-5'],
          recommended: 'gpt-5',
        },
        runtime: {
          type: 'standalone',
          connection: 'rest',
          minMemory: '512mb',
          ports: {
            http: 8080,
          },
        },
        configSchema: {
          type: 'object',
        },
        hooks: {
          postInstall: 'npm run setup',
        },
      },
      readme: '# Readme\n',
    });

    expect(payload).toEqual({
      displayName: 'Valid Agent',
      readme: '# Readme\n',
      categories: ['support', 'ops'],
      tags: ['chat', 'automation'],
      manifest: {
        name: 'valid-agent',
        version: '1.2.3',
        description: 'Registry-safe manifest',
        homepage: 'https://example.com/docs',
        repository: 'https://github.com/acme/valid-agent',
        capabilities: [
          { name: 'Summarize', description: 'Summaries' },
        ],
        context: {
          required: ['messages:write'],
          optional: ['context:read'],
        },
        integrations: {
          supported: ['discord', 'slack'],
          required: ['discord'],
        },
        models: {
          supported: ['gpt-5-mini', 'gpt-5'],
          recommended: 'gpt-5',
        },
        runtime: {
          type: 'standalone',
          connection: 'rest',
          minMemory: '512MB',
          ports: {
            http: 8080,
          },
        },
        configSchema: {
          type: 'object',
        },
        hooks: {
          postInstall: 'npm run setup',
        },
      },
    });
  });

  it('rejects malformed manifests with structured validation errors', () => {
    expect(() => normalizePublishPayload({
      manifest: {
        name: 'No Spaces Allowed',
        version: 'latest',
        homepage: 'ftp://example.com/file',
        integrations: {
          supported: ['discord'],
          required: ['slack'],
        },
        runtime: {
          ports: {
            http: 70000,
          },
        },
      },
      readme: { invalid: true },
    })).toThrow(ManifestValidationError);

    try {
      normalizePublishPayload({
        manifest: {
          name: 'No Spaces Allowed',
          version: 'latest',
          homepage: 'ftp://example.com/file',
          integrations: {
            supported: ['discord'],
            required: ['slack'],
          },
          runtime: {
            ports: {
              http: 70000,
            },
          },
        },
        readme: { invalid: true },
      });
    } catch (error) {
      expect(error.details).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'manifest.name' }),
        expect.objectContaining({ field: 'manifest.version' }),
        expect.objectContaining({ field: 'manifest.homepage' }),
        expect.objectContaining({ field: 'manifest.integrations.required' }),
        expect.objectContaining({ field: 'manifest.runtime.ports.http' }),
        expect.objectContaining({ field: 'readme' }),
      ]));
    }
  });
});

// TASK-043: the registry manifest is where routes/registry/install.ts reads a
// runtimeType the caller omitted. A published manifest that declares one and has
// it dropped by this normalizer is the same dead fallback one layer up — the
// publish path is the only writer for every agent the boot seeder did not create.
describe('manifest.runtime driver identity', () => {
  const publish = (runtime) => normalizePublishPayload({
    manifest: {
      name: 'runtime-wise', version: '1.0.0', description: 'd', runtime,
    },
  }).manifest.runtime;

  it('carries a declared driver identity through normalization', () => {
    expect(publish({ runtimeType: 'native' }).runtimeType).toBe('native');
  });

  it('normalizes case and padding so the install route reads one spelling', () => {
    expect(publish({ runtimeType: '  Native  ' }).runtimeType).toBe('native');
  });

  it('keeps the driver identity and the deployment shape as independent axes', () => {
    expect(publish({ type: 'hybrid', runtimeType: 'native' }))
      .toEqual({ type: 'hybrid', runtimeType: 'native' });
  });

  it('refuses a deployment shape in the driver-identity field', () => {
    // The two axes are one keystroke apart; refusing the swap here is what stops
    // a manifest from declaring how it is deployed as what runs it.
    expect(() => publish({ runtimeType: 'commonly-hosted' })).toThrow(ManifestValidationError);
  });
});
