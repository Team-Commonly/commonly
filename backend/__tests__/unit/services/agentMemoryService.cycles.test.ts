// @ts-nocheck
// ADR-012 §10.1 / §10.2: tests for the cycles[] section (agent-writable
// heartbeat-cadence journal) + the four emit-gated digest builders that
// feed event-payload injection.

const AgentMemory = require('../../../models/AgentMemory');
const {
  appendCycle,
  truncateCycleContent,
  buildMemoryDigest,
  buildCyclesDigest,
  buildLongTermDigest,
  buildRecentDailyDigest,
  buildMemoryDigestBundle,
  appendSystemExchange,
} = require('../../../services/agentMemoryService');
const {
  CYCLE_CONTENT_MAX,
  CYCLE_ENTRY_CAP,
} = require('../../../models/AgentMemory');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('truncateCycleContent (pure)', () => {
  it('passes through strings under the cap', () => {
    expect(truncateCycleContent('short')).toBe('short');
    expect(truncateCycleContent('')).toBe('');
  });

  it('appends a single ellipsis when over the cap and never exceeds it', () => {
    const long = 'x'.repeat(CYCLE_CONTENT_MAX + 50);
    const out = truncateCycleContent(long);
    expect(out.length).toBeLessThanOrEqual(CYCLE_CONTENT_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe('x'.repeat(CYCLE_CONTENT_MAX - 1) + '…');
  });

  it('coerces non-strings without throwing', () => {
    expect(truncateCycleContent(null)).toBe('');
    expect(truncateCycleContent(undefined)).toBe('');
    expect(truncateCycleContent(42)).toBe('42');
  });
});

describe('appendCycle (DB-backed)', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });

  it('creates the envelope on first call and seeds the entry most-recent-first', async () => {
    const result = await appendCycle({
      agentName: 'nova',
      instanceId: 'default',
      content: 'first reflection',
      ts: new Date('2026-05-04T00:00:00Z'),
    });
    expect(result).toEqual({ ok: true });
    const doc = await AgentMemory.findOne({ agentName: 'nova', instanceId: 'default' }).lean();
    expect(doc.sections.cycles.entries).toHaveLength(1);
    expect(doc.sections.cycles.entries[0].content).toBe('first reflection');
    expect(doc.sections.cycles.visibility).toBe('private');
  });

  it('appends new entries at position 0 (most-recent-first)', async () => {
    await appendCycle({ agentName: 'nova', instanceId: 'default', content: 'older', ts: new Date('2026-05-04T00:00:00Z') });
    await appendCycle({ agentName: 'nova', instanceId: 'default', content: 'newer', ts: new Date('2026-05-04T00:30:00Z') });
    const doc = await AgentMemory.findOne({ agentName: 'nova', instanceId: 'default' }).lean();
    expect(doc.sections.cycles.entries.map((e) => e.content)).toEqual(['newer', 'older']);
  });

  it('caps entries at CYCLE_ENTRY_CAP and evicts the oldest', async () => {
    for (let i = 0; i < CYCLE_ENTRY_CAP + 5; i++) {
      await appendCycle({
        agentName: 'pixel',
        instanceId: 'default',
        content: `cycle-${i}`,
        ts: new Date(`2026-05-04T00:${String(i).padStart(2, '0')}:00Z`),
      });
    }
    const doc = await AgentMemory.findOne({ agentName: 'pixel', instanceId: 'default' }).lean();
    expect(doc.sections.cycles.entries).toHaveLength(CYCLE_ENTRY_CAP);
    // Most-recent-first invariant: the newest is at index 0.
    expect(doc.sections.cycles.entries[0].content).toBe(`cycle-${CYCLE_ENTRY_CAP + 4}`);
  });

  it('truncates content at the schema cap', async () => {
    const long = 'y'.repeat(CYCLE_CONTENT_MAX + 50);
    await appendCycle({ agentName: 'aria', instanceId: 'default', content: long });
    const doc = await AgentMemory.findOne({ agentName: 'aria', instanceId: 'default' }).lean();
    expect(doc.sections.cycles.entries[0].content.length).toBeLessThanOrEqual(CYCLE_CONTENT_MAX);
    expect(doc.sections.cycles.entries[0].content.endsWith('…')).toBe(true);
  });

  it('returns null on missing required identity fields', async () => {
    expect(await appendCycle({ agentName: '', instanceId: 'x', content: 'a' })).toBeNull();
    expect(await appendCycle({ agentName: 'x', instanceId: '', content: 'a' })).toBeNull();
  });

  it('returns null on empty content (after trim)', async () => {
    expect(await appendCycle({ agentName: 'x', instanceId: 'default', content: '' })).toBeNull();
    expect(await appendCycle({ agentName: 'x', instanceId: 'default', content: '   ' })).toBeNull();
  });

  it('does NOT bump revision (cycles ≠ system_exchanges)', async () => {
    await appendCycle({ agentName: 'theo', instanceId: 'default', content: 'tick' });
    const doc = await AgentMemory.findOne({ agentName: 'theo', instanceId: 'default' }).lean();
    expect(doc.revision || 0).toBe(0);
  });

  it('does NOT clear lastSyncKey/lastSyncAt (invariant 8a-style carve-out)', async () => {
    await AgentMemory.create({
      agentName: 'theo',
      instanceId: 'default',
      lastSyncKey: 'preserve-me',
      lastSyncAt: new Date('2026-05-04T00:00:00Z'),
    });
    await appendCycle({ agentName: 'theo', instanceId: 'default', content: 'tick' });
    const doc = await AgentMemory.findOne({ agentName: 'theo', instanceId: 'default' }).lean();
    expect(doc.lastSyncKey).toBe('preserve-me');
    expect(doc.lastSyncAt).toEqual(new Date('2026-05-04T00:00:00Z'));
  });

  it('preserves podId when supplied', async () => {
    await appendCycle({
      agentName: 'theo',
      instanceId: 'default',
      content: 'with pod',
      podId: '69b7ddff0ce64c9648365fc4',
    });
    const doc = await AgentMemory.findOne({ agentName: 'theo', instanceId: 'default' }).lean();
    expect(doc.sections.cycles.entries[0].podId).toBe('69b7ddff0ce64c9648365fc4');
  });
});

describe('AgentMemory schema — cycles', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });

  it("rejects visibility != 'private' on the cycles section", async () => {
    const m = new AgentMemory({
      agentName: 'aria',
      instanceId: 'default',
      sections: {
        cycles: {
          entries: [],
          // @ts-expect-error — invalid by construction
          visibility: 'public',
          updatedAt: new Date(),
        },
      },
    });
    await expect(m.save()).rejects.toThrow();
  });

  it('rejects entries missing required ts', async () => {
    const m = new AgentMemory({
      agentName: 'aria',
      instanceId: 'default',
      sections: {
        cycles: {
          entries: [{ content: 'no ts' }],
          updatedAt: new Date(),
        },
      },
    });
    await expect(m.save()).rejects.toThrow();
  });
});

describe('digest builders (pure)', () => {
  describe('buildMemoryDigest', () => {
    it('returns [] when revision is unchanged (steady state)', () => {
      const env = { revision: 5, sections: { system_exchanges: { entries: [{}] } } };
      expect(buildMemoryDigest(env, 5)).toEqual([]);
    });

    it('returns the delta slice when revision is ahead of lastSeen', () => {
      const entries = [
        { takeaway: 'newest' },
        { takeaway: 'middle' },
        { takeaway: 'older' },
      ];
      const env = { revision: 5, sections: { system_exchanges: { entries } } };
      // revision 5, lastSeen 3 → delta of 2 → top 2 entries (most-recent-first storage).
      expect(buildMemoryDigest(env, 3)).toEqual([entries[0], entries[1]]);
    });

    it('returns [] when system_exchanges is absent', () => {
      const env = { revision: 5, sections: {} };
      expect(buildMemoryDigest(env, 0)).toEqual([]);
    });

    it('caps at the supplied max parameter', () => {
      const entries = Array.from({ length: 20 }, (_, i) => ({ takeaway: `e${i}` }));
      const env = { revision: 100, sections: { system_exchanges: { entries } } };
      expect(buildMemoryDigest(env, 0, 5)).toHaveLength(5);
    });
  });

  describe('buildCyclesDigest', () => {
    it('returns [] when section is missing', () => {
      expect(buildCyclesDigest({ sections: {} })).toEqual([]);
    });

    it('returns up to N most-recent entries', () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({ ts: new Date(), content: `c${i}` }));
      expect(buildCyclesDigest({ sections: { cycles: { entries } } }, 3)).toHaveLength(3);
    });

    it('emits all entries when fewer than the cap', () => {
      const entries = [{ ts: new Date(), content: 'one' }, { ts: new Date(), content: 'two' }];
      expect(buildCyclesDigest({ sections: { cycles: { entries } } }, 5)).toHaveLength(2);
    });
  });

  describe('buildLongTermDigest', () => {
    it('returns null on empty long_term', () => {
      expect(buildLongTermDigest({ sections: {} })).toBeNull();
      expect(buildLongTermDigest({ sections: { long_term: { content: '' } } })).toBeNull();
      expect(buildLongTermDigest({ sections: { long_term: { content: '   ' } } })).toBeNull();
    });

    it('passes through short content unchanged', () => {
      expect(buildLongTermDigest({ sections: { long_term: { content: 'short notes' } } })).toBe('short notes');
    });

    it('head-truncates with ellipsis when above the char cap', () => {
      const long = 'a'.repeat(900);
      const out = buildLongTermDigest({ sections: { long_term: { content: long } } }, 800);
      expect(out!.length).toBe(800);
      expect(out!.endsWith('…')).toBe(true);
    });
  });

  describe('buildRecentDailyDigest', () => {
    it('returns [] when section is empty', () => {
      expect(buildRecentDailyDigest({ sections: {} })).toEqual([]);
    });

    it('returns the most recent entries within the date window', () => {
      const now = new Date('2026-05-04T12:00:00Z');
      const env = {
        sections: {
          daily: [
            { date: '2026-05-01', content: 'mon' },
            { date: '2026-05-03', content: 'wed' },
            { date: '2026-04-20', content: 'old' },
            { date: '2026-05-04', content: 'today' },
          ],
        },
      };
      const out = buildRecentDailyDigest(env, { withinDays: 7, max: 2, now });
      expect(out).toHaveLength(2);
      expect(out[0].date).toBe('2026-05-04');
      expect(out[1].date).toBe('2026-05-03');
    });

    it('truncates content at charsEach', () => {
      const now = new Date('2026-05-04T12:00:00Z');
      const env = {
        sections: {
          daily: [{ date: '2026-05-04', content: 'z'.repeat(900) }],
        },
      };
      const out = buildRecentDailyDigest(env, { withinDays: 7, max: 2, charsEach: 400, now });
      expect(out).toHaveLength(1);
      expect(out[0].content.length).toBe(400);
      expect(out[0].content.endsWith('…')).toBe(true);
    });

    it('skips entries with empty content', () => {
      const now = new Date('2026-05-04T12:00:00Z');
      const env = {
        sections: {
          daily: [{ date: '2026-05-04', content: '' }, { date: '2026-05-03', content: 'real' }],
        },
      };
      const out = buildRecentDailyDigest(env, { withinDays: 7, max: 2, now });
      expect(out.map((d) => d.date)).toEqual(['2026-05-03']);
    });
  });

  describe('buildMemoryDigestBundle', () => {
    it('returns an empty bundle for a fresh envelope', () => {
      expect(buildMemoryDigestBundle({}, 0)).toEqual({});
    });

    it('emits memoryRevision only when > 0', () => {
      expect(buildMemoryDigestBundle({ revision: 0 }, 0).memoryRevision).toBeUndefined();
      expect(buildMemoryDigestBundle({ revision: 3 }, 0).memoryRevision).toBe(3);
    });

    it('omits each sub-field independently when its source section is empty', () => {
      const env = {
        revision: 1,
        sections: {
          long_term: { content: 'durable note' },
          // cycles + daily intentionally absent
        },
      };
      const out = buildMemoryDigestBundle(env, 0);
      expect(out.longTermDigest).toBe('durable note');
      expect(out.cyclesDigest).toBeUndefined();
      expect(out.recentDailyDigest).toBeUndefined();
    });

    it('produces all four sub-fields when the envelope is fully populated', () => {
      const now = new Date();
      const env = {
        revision: 5,
        sections: {
          system_exchanges: { entries: [{ takeaway: 'sys-1' }, { takeaway: 'sys-2' }] },
          cycles: { entries: [{ ts: now, content: 'cycle-1' }] },
          long_term: { content: 'durable' },
          daily: [{ date: new Date().toISOString().slice(0, 10), content: 'today' }],
        },
      };
      const out = buildMemoryDigestBundle(env, 3);
      expect(out.memoryRevision).toBe(5);
      expect(out.memoryDigest).toHaveLength(2);
      expect(out.cyclesDigest).toHaveLength(1);
      expect(out.longTermDigest).toBe('durable');
      expect(out.recentDailyDigest).toHaveLength(1);
    });
  });
});
