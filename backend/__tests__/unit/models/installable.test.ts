// @ts-nocheck
// Smoke test for the new Installable / InstallableInstallation scaffolding.
// Phase 1 / Step 1 of the Installable taxonomy refactor — only verifies that
// the schemas save, reject missing required fields, and enforce enums.
// Uses the in-memory MongoDB setup already shared with all other model tests.

import mongoose from 'mongoose';

const Installable = require('../../../models/Installable');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

describe('Installable taxonomy scaffolding', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  // --------------------------------------------------------------------- //
  // Installable                                                           //
  // --------------------------------------------------------------------- //

  it('saves an Installable with nested component + marketplace meta', async () => {
    const doc = new Installable({
      installableId: 'commonly/pod-welcomer',
      name: 'Pod Welcomer',
      description: 'Greets new members when they join a pod.',
      version: '1.0.0',
      kind: 'app',
      source: 'builtin',
      scope: 'pod',
      requires: ['pods:read', 'chat:write'],
      components: [
        {
          name: 'welcomer',
          type: 'event-handler',
          eventType: 'pod.join',
          eventHandler: 'internal:welcome',
          addresses: [{ mode: 'event', identifier: 'pod.join' }],
          scopes: ['chat:write'],
        },
      ],
      marketplace: {
        published: true,
        category: 'social',
        tags: ['welcome', 'onboarding'],
        verified: true,
        rating: 0,
        ratingCount: 0,
        installCount: 0,
      },
      stats: { totalInstalls: 0, activeInstalls: 0 },
    });

    const saved = await doc.save();
    expect(saved._id).toBeDefined();
    expect(saved.installableId).toBe('commonly/pod-welcomer');
    expect(saved.kind).toBe('app');
    expect(saved.status).toBe('active'); // default
    expect(saved.components).toHaveLength(1);
    expect(saved.components[0].type).toBe('event-handler');
    expect(saved.marketplace?.category).toBe('social');
  });

  it("defaults kind to 'app' when the manifest omits it", async () => {
    const doc = new Installable({
      installableId: 'commonly/no-kind-specified',
      name: 'No Kind',
      description: 'Legacy-shaped manifest — no kind field.',
      version: '1.0.0',
      source: 'marketplace',
      scope: 'pod',
      stats: { totalInstalls: 0, activeInstalls: 0 },
    });

    const saved = await doc.save();
    expect(saved.kind).toBe('app');
  });

  it('saves a kind:agent Installable with an Agent + Skill components', async () => {
    const doc = new Installable({
      installableId: 'marketplace/sarah-legal',
      name: 'Sarah — Legal Researcher',
      description: 'Pro agent specialized in US case law research.',
      version: '1.2.0',
      kind: 'agent',
      source: 'marketplace',
      scope: 'user',
      requires: ['chat:read', 'chat:write', 'memory:read', 'memory:write'],
      components: [
        {
          name: 'sarah',
          type: 'agent',
          runtime: 'native',
          persona: {
            displayName: 'Sarah',
            systemPrompt: 'You are Sarah, a pragmatic legal researcher...',
            memoryStrategy: 'persistent',
          },
          addresses: [{ mode: '@mention', identifier: '@sarah' }],
        },
        {
          name: 'westlaw-search',
          type: 'skill',
          skillId: 'westlaw-search',
          skillPrompt: 'When asked about case law, call the Westlaw search tool...',
          skillTools: ['westlaw_search', 'westlaw_cite'],
        },
        {
          name: 'citation-formatter',
          type: 'skill',
          skillId: 'citation-formatter',
          skillPrompt: 'Format citations in Bluebook style.',
        },
      ],
      marketplace: {
        published: true,
        category: 'professional',
        tags: ['legal', 'research', 'pro'],
        verified: true,
        rating: 4.8,
        ratingCount: 212,
        installCount: 1840,
      },
      stats: { totalInstalls: 0, activeInstalls: 0 },
    });

    const saved = await doc.save();
    expect(saved.kind).toBe('agent');
    expect(saved.components).toHaveLength(3);
    expect(saved.components[0].type).toBe('agent');
    expect(saved.components[1].type).toBe('skill');
    expect(saved.components[1].skillId).toBe('westlaw-search');
    expect(saved.components[1].skillTools).toContain('westlaw_cite');
  });

  it('saves a kind:skill standalone Installable (no runtime components)', async () => {
    const doc = new Installable({
      installableId: 'commonly/bluebook-citation',
      name: 'Bluebook Citation',
      description: 'Teaches any agent to format legal citations in Bluebook style.',
      version: '0.1.0',
      kind: 'skill',
      source: 'marketplace',
      scope: 'instance',
      requires: [],
      components: [
        {
          name: 'bluebook',
          type: 'skill',
          skillId: 'bluebook-citation',
          skillPrompt: 'Use Bluebook 21st edition formatting...',
        },
      ],
      stats: { totalInstalls: 0, activeInstalls: 0 },
    });

    const saved = await doc.save();
    expect(saved.kind).toBe('skill');
    expect(saved.components).toHaveLength(1);
    expect(saved.components[0].type).toBe('skill');
  });

  it('enforces kind enum', async () => {
    const bad = new Installable({
      installableId: 'bad-kind',
      name: 'Bad Kind',
      description: 'x',
      version: '1.0.0',
      kind: 'spaceship',
      source: 'builtin',
      scope: 'pod',
      stats: { totalInstalls: 0, activeInstalls: 0 },
    });
    await expect(bad.save()).rejects.toThrow(/kind/);
  });

  it('rejects an Installable missing required fields', async () => {
    const doc = new Installable({ name: 'no id', description: 'x' });
    await expect(doc.save()).rejects.toThrow();
  });

  it('enforces enum values for source and scope', async () => {
    const badSource = new Installable({
      installableId: 'bad-source',
      name: 'x',
      description: 'x',
      version: '1.0.0',
      source: 'not-a-real-source',
      scope: 'pod',
      stats: { totalInstalls: 0, activeInstalls: 0 },
    });
    await expect(badSource.save()).rejects.toThrow(/source/);

    const badScope = new Installable({
      installableId: 'bad-scope',
      name: 'x',
      description: 'x',
      version: '1.0.0',
      source: 'builtin',
      scope: 'galaxy',
      stats: { totalInstalls: 0, activeInstalls: 0 },
    });
    await expect(badScope.save()).rejects.toThrow(/scope/);
  });

  it('enforces installableId format', async () => {
    const bad = new Installable({
      installableId: 'Bad ID With Spaces',
      name: 'x',
      description: 'x',
      version: '1.0.0',
      source: 'builtin',
      scope: 'pod',
      stats: { totalInstalls: 0, activeInstalls: 0 },
    });
    await expect(bad.save()).rejects.toThrow();
  });

  // --------------------------------------------------------------------- //
  // InstallableInstallation                                               //
  // --------------------------------------------------------------------- //

  it('saves an InstallableInstallation pointing at a fake podId', async () => {
    const podId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const install = new InstallableInstallation({
      installableId: 'commonly/pod-welcomer',
      installableVersion: '1.0.0',
      targetType: 'pod',
      targetId: podId,
      scope: 'pod',
      installedBy: userId,
      installSource: 'system',
      grantedScopes: ['pods:read', 'chat:write'],
      components: [
        {
          componentName: 'welcomer',
          componentType: 'event-handler',
          instanceId: 'default',
          config: new Map([['greeting', 'hello']]),
        },
      ],
    });

    const saved = await install.save();
    expect(saved._id).toBeDefined();
    expect(saved.status).toBe('active');
    expect(saved.targetId.toString()).toBe(podId.toString());
    expect(saved.components).toHaveLength(1);
    expect(saved.components[0]._id).toBeDefined(); // component has stable _id
    expect(saved.components[0].status).toBe('active');
  });

  it('rejects an InstallableInstallation with invalid targetType enum', async () => {
    const bad = new InstallableInstallation({
      installableId: 'commonly/x',
      installableVersion: '1.0.0',
      targetType: 'planet',
      targetId: new mongoose.Types.ObjectId(),
      scope: 'pod',
      installedBy: new mongoose.Types.ObjectId(),
      installSource: 'system',
    });
    await expect(bad.save()).rejects.toThrow(/targetType/);
  });

  it('rejects an InstallableInstallation missing installedBy', async () => {
    const bad = new InstallableInstallation({
      installableId: 'commonly/x',
      installableVersion: '1.0.0',
      targetType: 'pod',
      targetId: new mongoose.Types.ObjectId(),
      scope: 'pod',
      installSource: 'system',
    });
    await expect(bad.save()).rejects.toThrow();
  });
});
