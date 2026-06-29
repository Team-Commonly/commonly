const {
  normalizeHeartbeatCycleTakeaway,
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

describe('normalizeHeartbeatCycleTakeaway (pure)', () => {
  it('trims and normalizes whitespace', () => {
    expect(normalizeHeartbeatCycleTakeaway('  hello\nworld\t ')).toBe('hello world');
  });

  it('collapses whitespace and removes markdown bullet prefixes', () => {
    expect(normalizeHeartbeatCycleTakeaway(' -   first\n- second')).toBe('first second');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeHeartbeatCycleTakeaway('   ')).toBe('');
  });
});

describe('buildMemoryDigest (pure)', () => {
  it('returns [] when section missing', () => {
    expect(buildMemoryDigest({ sections: {} }, 0)).toEqual([]);
  });

  it('returns newest entries first and respects delta', () => {
    const entries = [
      { takeaway: 'a' },
      { takeaway: 'b' },
      { takeaway: 'c' },
      { takeaway: 'd' },
    ];
    const env = { revision: 5, sections: { system_exchanges: { entries } } };
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

  it('returns the newest entries first and respects the default cap', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ ts: new Date(), content: `c${i}` }));
    const out = buildCyclesDigest({ sections: { cycles: { entries } } });
    expect(out).toHaveLength(5);
    expect(out.map((e) => e.content)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('returns the requested slice when capped below the default', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ ts: new Date(), content: `c${i}` }));
    expect(buildCyclesDigest({ sections: { cycles: { entries } } }, 3)).toEqual(entries.slice(0, 3));
  });

  it('returns fewer than the cap when the section is shorter', () => {
    const entries = [{ ts: new Date(), content: 'one' }, { ts: new Date(), content: 'two' }];
    expect(buildCyclesDigest({ sections: { cycles: { entries } } }, 5)).toHaveLength(2);
  });

  it('returns an empty array when cycles exists but entries is empty', () => {
    expect(buildCyclesDigest({ sections: { cycles: { entries: [] } } })).toEqual([]);
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
