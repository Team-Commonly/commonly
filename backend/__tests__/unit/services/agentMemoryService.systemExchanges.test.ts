// @ts-nocheck
// ADR-012 Phase 1: tests for the system_exchanges section + appendSystemExchange
// helper. Covers:
//   - schema acceptance + the 'private'-only enum
//   - takeaway truncation (truncateTakeaway pure function)
//   - appendSystemExchange most-recent-first ordering
//   - cap enforcement (50 entries; oldest evicted on overflow)
//   - revision monotonicity
//   - the AGENT_WRITABLE_SECTIONS allow-list (system_exchanges is excluded)
//   - invariant 8a: appendSystemExchange does NOT clear lastSyncKey/lastSyncAt

const AgentMemory = require('../../../models/AgentMemory');
const {
  appendSystemExchange,
  truncateTakeaway,
  isAgentWritableSection,
} = require('../../../services/agentMemoryService');
const {
  SYSTEM_EXCHANGE_TAKEAWAY_MAX,
  SYSTEM_EXCHANGE_ENTRY_CAP,
  AGENT_WRITABLE_SECTIONS,
} = require('../../../models/AgentMemory');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('truncateTakeaway (pure)', () => {
  it('passes through strings under the cap', () => {
    expect(truncateTakeaway('short')).toBe('short');
    expect(truncateTakeaway('')).toBe('');
  });

  it('appends a single ellipsis when over the cap and never exceeds it', () => {
    const long = 'x'.repeat(SYSTEM_EXCHANGE_TAKEAWAY_MAX + 50);
    const out = truncateTakeaway(long);
    expect(out.length).toBeLessThanOrEqual(SYSTEM_EXCHANGE_TAKEAWAY_MAX);
    expect(out.endsWith('…')).toBe(true);
    // Reserve exactly 1 char for the ellipsis.
    expect(out).toBe('x'.repeat(SYSTEM_EXCHANGE_TAKEAWAY_MAX - 1) + '…');
  });

  it('coerces non-strings without throwing', () => {
    expect(truncateTakeaway(null)).toBe('');
    expect(truncateTakeaway(undefined)).toBe('');
    expect(truncateTakeaway(42)).toBe('42');
  });
});

describe('isAgentWritableSection', () => {
  it('accepts every entry in AGENT_WRITABLE_SECTIONS', () => {
    for (const key of AGENT_WRITABLE_SECTIONS) {
      expect(isAgentWritableSection(key)).toBe(true);
    }
  });

  it('rejects system_exchanges (the read-only section)', () => {
    expect(isAgentWritableSection('system_exchanges')).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(isAgentWritableSection('not_a_section')).toBe(false);
    expect(isAgentWritableSection('')).toBe(false);
  });
});

describe('appendSystemExchange (DB-backed)', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });

  const baseEntry = {
    agentName: 'pixel',
    instanceId: 'default',
    kind: 'agent-dm-conclusion',
    surfacePodId: '69f7b89aabbccddeeff00011',
    surfaceLabel: 'agent-dm:69f7b89a',
    peers: ['codex-1'],
    takeaway: 'shipped the auth patch',
  };

  it('creates the envelope on first call and seeds the entry most-recent-first', async () => {
    const result = await appendSystemExchange({ ...baseEntry, ts: new Date('2026-05-03T00:00:00Z') });
    expect(result?.revision).toBe(1);

    const doc = await AgentMemory.findOne({ agentName: 'pixel', instanceId: 'default' }).lean();
    expect(doc?.sections?.system_exchanges?.entries).toHaveLength(1);
    expect(doc?.sections?.system_exchanges?.entries[0].kind).toBe('agent-dm-conclusion');
    expect(doc?.sections?.system_exchanges?.entries[0].takeaway).toBe('shipped the auth patch');
    expect(doc?.sections?.system_exchanges?.visibility).toBe('private');
    expect(doc?.revision).toBe(1);
  });

  it('appends new entries at position 0 (most-recent-first)', async () => {
    await appendSystemExchange({ ...baseEntry, takeaway: 'first', ts: new Date('2026-05-03T00:00:00Z') });
    await appendSystemExchange({ ...baseEntry, takeaway: 'second', ts: new Date('2026-05-03T00:01:00Z') });
    await appendSystemExchange({ ...baseEntry, takeaway: 'third', ts: new Date('2026-05-03T00:02:00Z') });

    const doc = await AgentMemory.findOne({ agentName: 'pixel', instanceId: 'default' }).lean();
    const ts = doc.sections.system_exchanges.entries.map((e) => e.takeaway);
    expect(ts).toEqual(['third', 'second', 'first']);
    expect(doc.revision).toBe(3);
  });

  it('caps entries at SYSTEM_EXCHANGE_ENTRY_CAP and evicts the oldest', async () => {
    const total = SYSTEM_EXCHANGE_ENTRY_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      // Sequential awaits so revisions land in order.
      // eslint-disable-next-line no-await-in-loop
      await appendSystemExchange({ ...baseEntry, takeaway: `entry-${i}`, ts: new Date(2026, 4, 3, 0, i) });
    }
    const doc = await AgentMemory.findOne({ agentName: 'pixel', instanceId: 'default' }).lean();
    expect(doc.sections.system_exchanges.entries).toHaveLength(SYSTEM_EXCHANGE_ENTRY_CAP);
    // Newest first: most recent push is `entry-${total-1}`.
    expect(doc.sections.system_exchanges.entries[0].takeaway).toBe(`entry-${total - 1}`);
    // Oldest in window is `entry-${total - CAP}` — evicted before that.
    expect(doc.sections.system_exchanges.entries[SYSTEM_EXCHANGE_ENTRY_CAP - 1].takeaway).toBe(
      `entry-${total - SYSTEM_EXCHANGE_ENTRY_CAP}`,
    );
    expect(doc.revision).toBe(total);
  });

  it('truncates takeaway to the schema cap', async () => {
    const long = 'y'.repeat(SYSTEM_EXCHANGE_TAKEAWAY_MAX + 100);
    await appendSystemExchange({ ...baseEntry, takeaway: long });
    const doc = await AgentMemory.findOne({ agentName: 'pixel', instanceId: 'default' }).lean();
    expect(doc.sections.system_exchanges.entries[0].takeaway.length).toBeLessThanOrEqual(SYSTEM_EXCHANGE_TAKEAWAY_MAX);
    expect(doc.sections.system_exchanges.entries[0].takeaway.endsWith('…')).toBe(true);
  });

  it('rejects unknown kinds (returns null without writing)', async () => {
    const result = await appendSystemExchange({ ...baseEntry, kind: 'bogus-kind' });
    expect(result).toBeNull();
    const doc = await AgentMemory.findOne({ agentName: 'pixel', instanceId: 'default' }).lean();
    expect(doc).toBeNull();
  });

  it('does not clear lastSyncKey / lastSyncAt (ADR-003 invariant 8a carve-out)', async () => {
    // Seed an envelope with a known sync state.
    const seededAt = new Date('2026-05-02T12:00:00Z');
    await AgentMemory.create({
      agentName: 'pixel',
      instanceId: 'default',
      content: 'legacy',
      lastSyncKey: '2026-05-02:openclaw:abcdef',
      lastSyncAt: seededAt,
    });

    await appendSystemExchange({ ...baseEntry });

    const doc = await AgentMemory.findOne({ agentName: 'pixel', instanceId: 'default' }).lean();
    expect(doc.lastSyncKey).toBe('2026-05-02:openclaw:abcdef');
    // Date precision: ensure preserved.
    expect(new Date(doc.lastSyncAt).getTime()).toBe(seededAt.getTime());
    expect(doc.sections.system_exchanges.entries).toHaveLength(1);
  });

  it('writes to two peers without cross-contamination', async () => {
    const ts = new Date('2026-05-03T01:00:00Z');
    await appendSystemExchange({
      agentName: 'pixel', instanceId: 'default',
      kind: 'agent-dm-conclusion',
      surfacePodId: '69f7b89aabbccddeeff00011',
      surfaceLabel: 'agent-dm:peers',
      peers: ['codex-1'],
      takeaway: 'pixel POV', ts,
    });
    await appendSystemExchange({
      agentName: 'codex', instanceId: 'codex-1',
      kind: 'agent-dm-conclusion',
      surfacePodId: '69f7b89aabbccddeeff00011',
      surfaceLabel: 'agent-dm:peers',
      peers: ['default'],
      takeaway: 'codex POV', ts,
    });

    const pixel = await AgentMemory.findOne({ agentName: 'pixel', instanceId: 'default' }).lean();
    const codex = await AgentMemory.findOne({ agentName: 'codex', instanceId: 'codex-1' }).lean();
    expect(pixel.sections.system_exchanges.entries[0].takeaway).toBe('pixel POV');
    expect(pixel.sections.system_exchanges.entries[0].peers).toEqual(['codex-1']);
    expect(codex.sections.system_exchanges.entries[0].takeaway).toBe('codex POV');
    expect(codex.sections.system_exchanges.entries[0].peers).toEqual(['default']);
  });

  it('returns null on missing required identity fields', async () => {
    expect(await appendSystemExchange({ ...baseEntry, agentName: '' })).toBeNull();
    expect(await appendSystemExchange({ ...baseEntry, instanceId: '' })).toBeNull();
    expect(await appendSystemExchange({ ...baseEntry, surfacePodId: '' })).toBeNull();
  });
});

describe('AgentMemory schema — system_exchanges', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });

  it("rejects visibility != 'private' on the system_exchanges section", async () => {
    await expect(
      AgentMemory.create({
        agentName: 'pixel',
        instanceId: 'default',
        sections: {
          system_exchanges: {
            entries: [],
            visibility: 'public',
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects entries with unknown 'kind'", async () => {
    await expect(
      AgentMemory.create({
        agentName: 'pixel',
        instanceId: 'default',
        sections: {
          system_exchanges: {
            entries: [{
              ts: new Date(),
              kind: 'unknown-kind',
              surfacePodId: 'pod1',
              surfaceLabel: '',
              peers: [],
              takeaway: '',
            }],
          },
        },
      }),
    ).rejects.toThrow();
  });

  it('defaults revision and lastSeenRevision to 0 on insert', async () => {
    const doc = await AgentMemory.create({ agentName: 'pixel', instanceId: 'fresh' });
    expect(doc.revision).toBe(0);
    expect(doc.lastSeenRevision).toBe(0);
  });
});
