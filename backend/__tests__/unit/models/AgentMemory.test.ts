// @ts-nocheck
// ADR-003 Phase 1: schema-level tests for the v2 AgentMemory envelope.
// Verifies unique index preservation, section sub-schema defaults, visibility
// enum enforcement, and that v1 (`content` only) writes still work.

const AgentMemory = require('../../../models/AgentMemory');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('AgentMemory (ADR-003 v2 schema)', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('accepts the legacy v1 shape with only content', async () => {
    const doc = await AgentMemory.create({
      agentName: 'openclaw',
      instanceId: 'alice',
      content: '# MEMORY.md\nSome long-term stuff.',
    });
    expect(doc.content).toContain('long-term stuff');
    expect(doc.sections).toBeUndefined();
    expect(doc.sourceRuntime).toBeUndefined();
    expect(doc.schemaVersion).toBeUndefined();
  });

  it('accepts the v2 envelope with typed sections', async () => {
    const now = new Date();
    const doc = await AgentMemory.create({
      agentName: 'openclaw',
      instanceId: 'bob',
      content: '',
      sections: {
        long_term: { content: 'curated', visibility: 'private', updatedAt: now, byteSize: 7 },
        dedup_state: { content: '## Commented\n{}', visibility: 'private' },
        daily: [{ date: '2026-04-14', content: 'today', visibility: 'private' }],
        relationships: [
          { otherInstanceId: 'nova', notes: 'met in dev pod', visibility: 'private' },
        ],
        shared: { content: 'my bio', visibility: 'public' },
      },
      sourceRuntime: 'openclaw',
      schemaVersion: 2,
    });
    expect(doc.sections?.long_term?.content).toBe('curated');
    expect(doc.sections?.dedup_state?.content).toContain('Commented');
    expect(doc.sections?.daily?.[0]?.date).toBe('2026-04-14');
    expect(doc.sections?.relationships?.[0]?.otherInstanceId).toBe('nova');
    expect(doc.sections?.shared?.visibility).toBe('public');
    expect(doc.sourceRuntime).toBe('openclaw');
    expect(doc.schemaVersion).toBe(2);
  });

  it('defaults visibility to "private" on sections', async () => {
    const doc = await AgentMemory.create({
      agentName: 'openclaw',
      instanceId: 'carol',
      sections: { long_term: { content: 'x' } },
    });
    expect(doc.sections?.long_term?.visibility).toBe('private');
  });

  it('rejects an invalid visibility value', async () => {
    await expect(
      AgentMemory.create({
        agentName: 'openclaw',
        instanceId: 'dave',
        sections: { long_term: { content: 'x', visibility: 'everyone' } },
      }),
    ).rejects.toThrow();
  });

  it('enforces unique (agentName, instanceId)', async () => {
    await AgentMemory.create({ agentName: 'openclaw', instanceId: 'eve', content: 'a' });
    await expect(
      AgentMemory.create({ agentName: 'openclaw', instanceId: 'eve', content: 'b' }),
    ).rejects.toThrow();
  });

  it('permits different instanceIds under the same agentName', async () => {
    await AgentMemory.create({ agentName: 'openclaw', instanceId: 'a', content: '1' });
    await AgentMemory.create({ agentName: 'openclaw', instanceId: 'b', content: '2' });
    const rows = await AgentMemory.find({ agentName: 'openclaw' });
    expect(rows.length).toBe(2);
  });

  it('permits the same instanceId under different agentName (envelope is keyed by both)', async () => {
    await AgentMemory.create({ agentName: 'openclaw', instanceId: 'shared', content: '1' });
    await AgentMemory.create({ agentName: 'webhook', instanceId: 'shared', content: '2' });
    const rows = await AgentMemory.find({ instanceId: 'shared' });
    expect(rows.length).toBe(2);
  });

  it('sets createdAt and updatedAt via timestamps:true', async () => {
    const doc = await AgentMemory.create({ agentName: 'openclaw', instanceId: 'f', content: 'x' });
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
  });

  it('requires a daily entry to have a date', async () => {
    await expect(
      AgentMemory.create({
        agentName: 'openclaw',
        instanceId: 'g',
        sections: { daily: [{ content: 'no date' }] },
      }),
    ).rejects.toThrow();
  });

  it('requires a relationship entry to have otherInstanceId', async () => {
    await expect(
      AgentMemory.create({
        agentName: 'openclaw',
        instanceId: 'h',
        sections: { relationships: [{ notes: 'orphan' }] },
      }),
    ).rejects.toThrow();
  });

  it('does not drop content when sections are also written', async () => {
    const doc = await AgentMemory.create({
      agentName: 'openclaw',
      instanceId: 'i',
      content: 'legacy blob',
      sections: { long_term: { content: 'new' } },
    });
    expect(doc.content).toBe('legacy blob');
    expect(doc.sections?.long_term?.content).toBe('new');
  });
});
