const mongoose = require('mongoose');
const Installable = require('../../../models/Installable');
const {
  registryToInstallable,
  installableToRegistryView,
} = require('../../../services/installable/agentRegistryBridge');

const publisherId = new mongoose.Types.ObjectId();
const createdAt = new Date('2026-09-01T00:00:00Z');

const fullRow = (overrides = {}) => ({
  agentName: 'research-helper',
  displayName: 'Research Helper',
  description: 'Finds and summarizes papers.',
  readme: '# Research Helper',
  manifest: {
    name: 'research-helper',
    version: '2.1.0',
    description: 'Finds and summarizes papers.',
    capabilities: [{ name: 'search', description: 'Search papers' }],
    context: { required: ['context:read', 'messages:write'], optional: ['memory:read'] },
    runtime: { type: 'standalone', connection: 'rest', runtimeType: 'native' },
    configSchema: { defaultInstructions: 'Cite every source.' },
  },
  versions: [
    { version: '2.0.0', publishedAt: new Date('2026-09-02T00:00:00Z'), deprecated: true, deprecationReason: 'old' },
    { version: '2.1.0', publishedAt: new Date('2026-09-03T00:00:00Z') },
  ],
  latestVersion: '2.1.0',
  registry: 'commonly-community',
  verified: true,
  publisher: { userId: publisherId, name: 'alice' },
  categories: ['research', 'productivity'],
  tags: ['papers', 'citations'],
  stats: { installs: 7, weeklyInstalls: 2, rating: 4.5, ratingCount: 3 },
  status: 'active',
  iconUrl: 'bottts:research',
  ephemeral: false,
  createdAt,
  ...overrides,
});

// Through the real schema, so a field mongoose would drop on save fails here.
const viaSchema = (row) => {
  const doc = new Installable(registryToInstallable(row));
  const err = doc.validateSync();
  if (err) throw err;
  return doc.toObject();
};

const pickReadFields = (view) => ({
  agentName: view.agentName,
  displayName: view.displayName,
  description: view.description,
  readme: view.readme,
  latestVersion: view.latestVersion,
  versions: view.versions,
  status: view.status,
  registry: view.registry,
  ephemeral: view.ephemeral,
  verified: view.verified,
  publisher: view.publisher,
  categories: view.categories,
  tags: view.tags,
  stats: view.stats,
  iconUrl: view.iconUrl,
  requiredScopes: view.manifest.context.required,
  optionalScopes: view.manifest.context.optional,
  runtimeType: view.manifest.runtime.runtimeType,
  runtimeShape: view.manifest.runtime.type,
  runtimeConnection: view.manifest.runtime.connection,
  defaultInstructions: view.manifest.configSchema?.defaultInstructions,
  capabilities: view.manifest.capabilities,
});

describe('agentRegistryBridge', () => {
  test('every field install, catalog and pod-agents read survives the round trip', () => {
    const row = fullRow();
    const view = installableToRegistryView(viaSchema(row));
    expect(pickReadFields(view)).toEqual({
      agentName: 'research-helper',
      displayName: 'Research Helper',
      description: 'Finds and summarizes papers.',
      readme: '# Research Helper',
      latestVersion: '2.1.0',
      versions: [
        { version: '2.0.0', publishedAt: new Date('2026-09-02T00:00:00Z'), deprecated: true, deprecationReason: 'old' },
        { version: '2.1.0', publishedAt: new Date('2026-09-03T00:00:00Z') },
      ],
      status: 'active',
      registry: 'commonly-community',
      ephemeral: false,
      verified: true,
      publisher: { userId: publisherId, name: 'alice' },
      categories: ['research', 'productivity'],
      tags: ['papers', 'citations'],
      stats: { installs: 7, weeklyInstalls: 2, rating: 4.5, ratingCount: 3 },
      iconUrl: 'bottts:research',
      requiredScopes: ['context:read', 'messages:write'],
      optionalScopes: ['memory:read'],
      runtimeType: 'native',
      runtimeShape: 'standalone',
      runtimeConnection: 'rest',
      defaultInstructions: 'Cite every source.',
      capabilities: [{ name: 'search', description: 'Search papers' }],
    });
  });

  test('maps the field table: name, version, requires, category and tags', () => {
    const doc = registryToInstallable(fullRow());
    expect(doc).toMatchObject({
      installableId: 'research-helper',
      name: 'Research Helper',
      version: '2.1.0',
      kind: 'agent',
      source: 'marketplace',
      requires: ['context:read', 'messages:write'],
      marketplace: {
        published: true,
        verified: true,
        category: 'research',
        tags: ['productivity', 'papers', 'citations'],
      },
    });
    expect(doc.components).toHaveLength(1);
    expect(doc.components[0]).toMatchObject({
      type: 'agent',
      runtime: 'native',
      persona: { avatar: 'bottts:research', displayName: 'Research Helper' },
      metadata: {
        registryManifest: {
          defaultInstructions: 'Cite every source.',
          runtimeType: 'native',
          contextOptional: ['memory:read'],
          capabilities: [{ name: 'search', description: 'Search papers' }],
        },
      },
    });
  });

  test('a stored moltbot row maps and loads', () => {
    const row = fullRow({
      agentName: 'newshound',
      manifest: { ...fullRow().manifest, runtime: { type: 'standalone', connection: 'rest', runtimeType: 'moltbot' } },
    });
    const loaded = viaSchema(row);
    expect(loaded.components[0].runtime).toBe('moltbot');
    expect(installableToRegistryView(loaded).manifest.runtime.runtimeType).toBe('moltbot');
  });

  test('a runtimeType outside the component enum keeps it in metadata only', () => {
    const row = fullRow({
      manifest: { ...fullRow().manifest, runtime: { type: 'standalone', runtimeType: 'wrapper' } },
    });
    const loaded = viaSchema(row);
    expect(loaded.components[0].runtime).toBeUndefined();
    expect(installableToRegistryView(loaded).manifest.runtime.runtimeType).toBe('wrapper');
  });

  test('an ephemeral row maps to source user, owned by its installer, unpublished', () => {
    const row = fullRow({ registry: 'private', ephemeral: true, verified: false });
    const doc = registryToInstallable(row);
    expect(doc.source).toBe('user');
    expect(String(doc.owner)).toBe(String(publisherId));
    expect(doc.marketplace.published).toBe(false);
    const view = installableToRegistryView(viaSchema(row));
    expect(view.ephemeral).toBe(true);
    expect(view.registry).toBe('private');
  });

  test('an ephemeral row stays unpublished even when it is marked verified', () => {
    expect(registryToInstallable(fullRow({ ephemeral: true })).marketplace.published).toBe(false);
  });

  test('an unverified row is unpublished', () => {
    const doc = registryToInstallable(fullRow({ verified: false }));
    expect(doc.source).toBe('marketplace');
    expect(doc.marketplace.published).toBe(false);
  });

  test('an inactive verified row is unpublished', () => {
    expect(registryToInstallable(fullRow({ status: 'deprecated' })).marketplace.published).toBe(false);
  });

  test('an official row is builtin at instance scope', () => {
    const doc = registryToInstallable(fullRow({ registry: 'commonly-official' }));
    expect(doc.source).toBe('builtin');
    expect(doc.scope).toBe('instance');
    expect(installableToRegistryView(viaSchema(fullRow({ registry: 'commonly-official' }))).registry)
      .toBe('commonly-official');
  });

  test('a sparse synthesized row (no versions, stats, icon or runtimeType) still loads', () => {
    const sparse = {
      agentName: 'my-byo',
      displayName: 'my-byo',
      description: 'An agent',
      manifest: { name: 'my-byo', version: '1.0.0', runtime: { type: 'standalone', connection: 'rest' } },
      registry: 'private',
      ephemeral: true,
      publisher: { userId: publisherId },
    };
    const loaded = viaSchema(sparse);
    const view = installableToRegistryView(loaded);
    expect(view.latestVersion).toBe('1.0.0');
    expect(view.iconUrl).toBeUndefined();
    expect(view.manifest.context.required).toEqual([]);
    expect(view.stats).toEqual({ installs: 0, weeklyInstalls: 0, rating: 0, ratingCount: 0 });
  });

  test('a marketplace-published Installable with no registry metadata reads as community', () => {
    const view = installableToRegistryView({
      installableId: '@alice/helper',
      name: 'Helper',
      description: 'd',
      version: '1.0.0',
      source: 'marketplace',
      requires: ['context:read'],
      components: [{ name: 'helper', type: 'agent', runtime: 'webhook' }],
      marketplace: { published: true, verified: false, category: 'dev', tags: ['x'] },
      status: 'active',
      stats: { totalInstalls: 2 },
    });
    expect(view).toMatchObject({
      agentName: '@alice/helper',
      registry: 'commonly-community',
      ephemeral: false,
      verified: false,
      categories: ['dev'],
      tags: ['x'],
      manifest: { context: { required: ['context:read'] }, runtime: { runtimeType: 'webhook' } },
    });
  });
});
