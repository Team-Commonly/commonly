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
