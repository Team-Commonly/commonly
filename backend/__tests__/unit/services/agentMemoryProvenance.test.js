/**
 * GH#632 Tier-1 foundation: provenance stamp + capped version history on
 * memory section writes (decorateSectionsWithProvenance).
 */
const {
  decorateSectionsWithProvenance,
  stampSectionsForWrite,
} = require('../../../services/agentMemoryService');
const { MEMORY_HISTORY_CAP } = require('../../../models/AgentMemory');

const now = new Date('2026-07-05T12:00:00Z');
const src = { runtime: 'claude-code', via: 'memory-put' };

describe('decorateSectionsWithProvenance', () => {
  it('stamps source (with writtenAt) on every blob section write', () => {
    const stamped = stampSectionsForWrite({ long_term: { content: 'v1' } }, now);
    const out = decorateSectionsWithProvenance(undefined, stamped, src, now);
    expect(out.long_term.source).toMatchObject({ runtime: 'claude-code', via: 'memory-put' });
    expect(out.long_term.source.writtenAt).toEqual(now);
    expect(out.long_term.history).toBeUndefined(); // fresh doc — nothing replaced
  });

  it('pushes the replaced content into history, newest first, carrying its source', () => {
    const prior = {
      long_term: {
        content: 'old fact',
        visibility: 'private',
        updatedAt: new Date('2026-07-01T00:00:00Z'),
        byteSize: 8,
        source: { runtime: 'codex', via: 'memory-sync' },
      },
    };
    const stamped = stampSectionsForWrite({ long_term: { content: 'new fact' } }, now);
    const out = decorateSectionsWithProvenance(prior, stamped, src, now);
    expect(out.long_term.content).toBe('new fact');
    expect(out.long_term.history).toHaveLength(1);
    expect(out.long_term.history[0]).toMatchObject({
      content: 'old fact',
      source: { runtime: 'codex', via: 'memory-sync' },
    });
  });

  it('is idempotent: unchanged content does not grow history but carries it forward', () => {
    const prior = {
      long_term: {
        content: 'same',
        visibility: 'private',
        updatedAt: now,
        byteSize: 4,
        history: [{ content: 'older', replacedAt: now }],
      },
    };
    const stamped = stampSectionsForWrite({ long_term: { content: 'same' } }, now);
    const out = decorateSectionsWithProvenance(prior, stamped, src, now);
    expect(out.long_term.history).toHaveLength(1);
    expect(out.long_term.history[0].content).toBe('older');
  });

  it('caps history at MEMORY_HISTORY_CAP', () => {
    const bigHistory = Array.from({ length: MEMORY_HISTORY_CAP }, (_, i) => ({
      content: `v${i}`, replacedAt: now,
    }));
    const prior = {
      long_term: {
        content: 'current', visibility: 'private', updatedAt: now, byteSize: 7,
        history: bigHistory,
      },
    };
    const stamped = stampSectionsForWrite({ long_term: { content: 'newest' } }, now);
    const out = decorateSectionsWithProvenance(prior, stamped, src, now);
    expect(out.long_term.history).toHaveLength(MEMORY_HISTORY_CAP);
    expect(out.long_term.history[0].content).toBe('current'); // newest first
    expect(out.long_term.history[MEMORY_HISTORY_CAP - 1].content).toBe(`v${MEMORY_HISTORY_CAP - 2}`); // oldest dropped
  });

  it('leaves array sections (daily/relationships) untouched', () => {
    const stamped = stampSectionsForWrite({
      daily: [{ date: '2026-07-05', content: 'today' }],
    }, now);
    const out = decorateSectionsWithProvenance(undefined, stamped, src, now);
    expect(out.daily).toEqual(stamped.daily);
    expect(out.daily.source).toBeUndefined();
  });
});
